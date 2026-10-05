import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  SecretUnreadableError,
  decryptSecret,
  encryptSecret,
} from "$lib/server/crypto";
import {
  bills,
  first,
  getDB,
  isUniqueViolation,
  paperlessConnections,
  paperlessDismissed,
  paperlessDocuments,
  paperlessInstances,
  type DB,
  type PaperlessBillSource,
  type PaperlessFieldMapping,
  transaction,
} from "$lib/server/db";
import {
  PrivateNetworkError,
  assertHostAllowed,
  isPrivateLiteralHost,
  privateNetworkAllowedForUser,
} from "$lib/server/net/private-network";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import {
  PaperlessClient,
  PaperlessError,
  errorCode,
  normalizeBaseUrl,
  pageSchema,
} from "./client";
import {
  savedViewRuleSchema,
  translateFilterRules,
  type Translation,
} from "./saved-views";

export const MIN_PAPERLESS_VERSION = "2.16.0";

export type ConnectionRow = typeof paperlessConnections.$inferSelect;

/** Stable per Paperless server, so reconnecting never duplicates bills. */
export function instanceKey(baseUrl: string): string {
  return createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
}

export function externalRef(baseUrl: string, paperlessId: number): string {
  return `${instanceKey(baseUrl)}:${paperlessId}`;
}

/** The key of the connection's server: stored, or (older rows) derived from the address. */
export function rowInstanceKey(row: ConnectionRow): string {
  return row.instanceKey ?? instanceKey(row.baseUrl);
}

export function rowExternalRef(
  row: ConnectionRow,
  paperlessId: number,
): string {
  return `${rowInstanceKey(row)}:${paperlessId}`;
}

export async function isDismissed(
  userId: string,
  ref: string,
): Promise<boolean> {
  const found = await first(
    getDB()
      .select({ id: paperlessDismissed.id })
      .from(paperlessDismissed)
      .where(
        and(
          eq(paperlessDismissed.userId, userId),
          eq(paperlessDismissed.externalRef, ref),
        ),
      )
      .limit(1),
  );
  return found !== undefined;
}

type Tx = Pick<DB, "select" | "insert" | "update" | "delete">;

/** Remembers which key the user's server had at `baseUrl`, so a later reconnect reuses it. */
async function rememberInstance(
  tx: Tx,
  userId: string,
  baseUrl: string,
  key: string,
): Promise<void> {
  await tx
    .insert(paperlessInstances)
    .values({ userId, baseUrl, instanceKey: key })
    .onConflictDoUpdate({
      target: [paperlessInstances.userId, paperlessInstances.baseUrl],
      set: { instanceKey: key },
    });
}

async function rememberedKey(
  tx: Pick<DB, "select">,
  userId: string,
  baseUrl: string,
): Promise<string | null> {
  return (
    (
      await first(
        tx
          .select({ key: paperlessInstances.instanceKey })
          .from(paperlessInstances)
          .where(
            and(
              eq(paperlessInstances.userId, userId),
              eq(paperlessInstances.baseUrl, baseUrl),
            ),
          )
          .limit(1),
      )
    )?.key ?? null
  );
}

/** Before link rows go away: keeps the documents whose bill the user deleted from coming back. */
async function rememberDismissed(tx: Tx, row: ConnectionRow): Promise<void> {
  const dismissed = await tx
    .select({ paperlessId: paperlessDocuments.paperlessId })
    .from(paperlessDocuments)
    .where(
      and(
        eq(paperlessDocuments.userId, row.userId),
        eq(paperlessDocuments.connectionId, row.id),
        eq(paperlessDocuments.status, "imported"),
        isNull(paperlessDocuments.billId),
      ),
    );
  if (dismissed.length === 0) return;
  await tx
    .insert(paperlessDismissed)
    .values(
      dismissed.map((d) => ({
        userId: row.userId,
        externalRef: rowExternalRef(row, d.paperlessId),
      })),
    )
    .onConflictDoNothing();
}

/** Everything the UI may see: no token, no secret hash. */
export interface ConnectionView {
  id: string;
  baseUrl: string;
  apiVersion: number | null;
  serverVersion: string | null;
  billSource: PaperlessBillSource | null;
  fieldMapping: PaperlessFieldMapping | null;
  allowInsecureTls: boolean;
  enabled: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  webhookToken: string;
  /** The stored token cannot be decrypted (KEPT_SECRET_KEY changed): it must be entered again. */
  tokenUnreadable: boolean;
  createdAt: number;
}

export function isTokenUnreadable(row: ConnectionRow): boolean {
  try {
    decryptSecret(row.tokenEncrypted);
    return false;
  } catch (err) {
    if (err instanceof SecretUnreadableError) return true;
    throw err;
  }
}

export function toView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    apiVersion: row.apiVersion,
    serverVersion: row.serverVersion,
    billSource: row.billSource ?? null,
    fieldMapping: row.fieldMapping ?? null,
    allowInsecureTls: row.allowInsecureTls,
    enabled: row.enabled,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.getTime() : null,
    lastError: row.lastError,
    webhookToken: row.webhookToken,
    tokenUnreadable: isTokenUnreadable(row),
    createdAt: row.createdAt.getTime(),
  };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time check of a presented webhook secret against the stored hash. */
export function secretMatches(row: ConnectionRow, presented: string): boolean {
  const a = Buffer.from(hashSecret(presented), "hex");
  const b = Buffer.from(row.webhookSecretHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const newInstanceKey = () => randomBytes(6).toString("hex");
const newWebhookToken = () => randomBytes(24).toString("base64url");
const newWebhookSecret = () => randomBytes(32).toString("base64url");

function userConnectionQuery(tx: Pick<DB, "select">, userId: string) {
  return tx
    .select()
    .from(paperlessConnections)
    .where(eq(paperlessConnections.userId, userId))
    .limit(1);
}

export async function getConnectionRow(
  userId: string,
): Promise<ConnectionRow | null> {
  return (await first(userConnectionQuery(getDB(), userId))) ?? null;
}

/** `getConnectionRow` on a transaction you already hold. */
async function getConnectionRowInTx(
  tx: Pick<DB, "select">,
  userId: string,
): Promise<ConnectionRow | null> {
  return (await first(userConnectionQuery(tx, userId))) ?? null;
}

export async function getConnection(
  userId: string,
): Promise<ConnectionView | null> {
  const row = await getConnectionRow(userId);
  return row ? toView(row) : null;
}

export async function hasPaperlessConnection(userId: string): Promise<boolean> {
  return (await getConnectionRow(userId)) !== null;
}

export async function requireConnectionRow(
  userId: string,
): Promise<ConnectionRow> {
  const row = await getConnectionRow(userId);
  if (!row) throw notFound("Paperless connection");
  return row;
}

/** The connection a webhook URL token belongs to (public endpoint; no user context yet). */
export async function getConnectionByWebhookToken(
  token: string,
): Promise<ConnectionRow | null> {
  return (
    (await first(
      getDB()
        .select()
        .from(paperlessConnections)
        .where(eq(paperlessConnections.webhookToken, token))
        .limit(1),
    )) ?? null
  );
}

export function listEnabledConnections(): Promise<ConnectionRow[]> {
  return getDB()
    .select()
    .from(paperlessConnections)
    .where(eq(paperlessConnections.enabled, true));
}

export const tokenSchema = z
  .string()
  .trim()
  .max(512, "The token is too long.")
  .regex(/^[\x21-\x7e]+$/, "The token contains invalid characters.");

export interface SaveConnectionInput {
  baseUrl: string;
  /** Required for a new connection; blank keeps the stored token. */
  token?: string | null;
  allowInsecureTls: boolean;
  /**
   * The address now points at a different Paperless server (or a reinstalled one): forget the
   * links to the old server's documents and start over. Without it, an address change keeps them.
   */
  differentInstance?: boolean;
  /** Whether this user may point Kept at private-network hosts; see `privateNetworkAllowed`. */
  allowPrivateNetwork?: boolean;
}

export interface SaveConnectionResult {
  connection: ConnectionView;
  /** Plain webhook secret; only present when the connection was just created. */
  webhookSecret: string | null;
}

/**
 * Creates the user's connection or updates it (one per user). The lookup of the
 * current row, the instance-key bookkeeping and the write share one transaction.
 * A second connection created concurrently is caught by the unique user index.
 */
export async function saveConnection(
  userId: string,
  input: SaveConnectionInput,
): Promise<SaveConnectionResult> {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl);
  } catch (err) {
    if (err instanceof PaperlessError) {
      throw new LedgerError("invalid", err.message, "baseUrl");
    }
    throw err;
  }
  if (input.allowPrivateNetwork === false && isPrivateLiteralHost(baseUrl)) {
    throw new LedgerError(
      "invalid",
      new PaperlessError("blocked_address").message,
      "baseUrl",
    );
  }
  const token = input.token?.trim() ? input.token.trim() : null;
  if (token !== null) {
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success) {
      throw new LedgerError(
        "invalid",
        parsed.error.issues[0]!.message,
        "token",
      );
    }
  }
  try {
    return await transaction(async (tx) =>
      saveConnectionInTx(tx, userId, input, baseUrl, token),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new LedgerError(
        "conflict",
        "The Paperless connection was changed at the same time. Reload and try again.",
      );
    }
    throw err;
  }
}

async function saveConnectionInTx(
  tx: Tx,
  userId: string,
  input: SaveConnectionInput,
  baseUrl: string,
  token: string | null,
): Promise<SaveConnectionResult> {
  const existing = await getConnectionRowInTx(tx, userId);

  if (!existing) {
    if (token === null) {
      throw new LedgerError("invalid", "Enter the access token.", "token");
    }
    const secret = newWebhookSecret();
    const row = (await first(
      tx
        .insert(paperlessConnections)
        .values({
          userId,
          baseUrl,
          tokenEncrypted: encryptSecret(token),
          instanceKey:
            (await rememberedKey(tx, userId, baseUrl)) ?? instanceKey(baseUrl),
          allowInsecureTls: input.allowInsecureTls,
          webhookSecretHash: hashSecret(secret),
          webhookToken: newWebhookToken(),
        })
        .returning(),
    ))!;
    return { connection: toView(row), webhookSecret: secret };
  }

  if (token === null && isTokenUnreadable(existing)) {
    throw new LedgerError(
      "invalid",
      new PaperlessError("token_unreadable").message,
      "token",
    );
  }
  const moved = existing.baseUrl !== baseUrl;
  const reset = input.differentInstance === true;
  if (moved) {
    await rememberInstance(
      tx,
      userId,
      existing.baseUrl,
      rowInstanceKey(existing),
    );
  }
  if (reset) {
    // Another server has other document ids: old links and watermark are meaningless.
    await rememberDismissed(tx, existing);
    await tx
      .delete(paperlessDocuments)
      .where(
        and(
          eq(paperlessDocuments.userId, userId),
          eq(paperlessDocuments.connectionId, existing.id),
        ),
      );
  } else if (moved) {
    // Same server under a new address: bills keep their links, only their stored urls follow.
    await tx
      .update(bills)
      .set({
        externalUrl: sql`${baseUrl} || substr(${bills.externalUrl}, length(${existing.baseUrl}) + 1)`,
      })
      .where(
        and(
          eq(bills.userId, userId),
          eq(bills.externalSource, "paperless"),
          sql`substr(${bills.externalUrl}, 1, length(${existing.baseUrl}) + 1) = ${existing.baseUrl + "/"}`,
        ),
      );
  }
  const row = (await first(
    tx
      .update(paperlessConnections)
      .set({
        baseUrl,
        instanceKey: reset ? newInstanceKey() : rowInstanceKey(existing),
        allowInsecureTls: input.allowInsecureTls,
        ...(token !== null ? { tokenEncrypted: encryptSecret(token) } : {}),
        ...(moved || reset
          ? { apiVersion: null, serverVersion: null, lastSyncAt: null }
          : {}),
        ...(reset ? { lastSyncModified: null } : {}),
        ...(moved || reset || token !== null ? { lastError: null } : {}),
      })
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, existing.id),
        ),
      )
      .returning(),
  ))!;
  return { connection: toView(row), webhookSecret: null };
}

/** Replaces the webhook secret; the old one stops working immediately. */
export async function rotateWebhookSecret(userId: string): Promise<string> {
  const secret = newWebhookSecret();
  const updated = await getDB()
    .update(paperlessConnections)
    .set({ webhookSecretHash: hashSecret(secret) })
    .where(eq(paperlessConnections.userId, userId))
    .returning({ id: paperlessConnections.id });
  if (updated.length === 0) throw notFound("Paperless connection");
  return secret;
}

/** Removes the connection and its link rows. Bills and their stored documents stay. */
export async function deleteConnection(userId: string): Promise<void> {
  await transaction(async (tx) => {
    const row = await getConnectionRowInTx(tx, userId);
    if (!row) throw notFound("Paperless connection");
    await rememberDismissed(tx, row);
    await rememberInstance(tx, userId, row.baseUrl, rowInstanceKey(row));
    await tx
      .delete(paperlessConnections)
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, row.id),
        ),
      );
  });
}

/** Updates the user's one connection and returns it; not found when there is none. */
async function updateConnection(
  userId: string,
  patch: Partial<typeof paperlessConnections.$inferInsert>,
): Promise<ConnectionView> {
  const [row] = await getDB()
    .update(paperlessConnections)
    .set(patch)
    .where(eq(paperlessConnections.userId, userId))
    .returning();
  if (!row) throw notFound("Paperless connection");
  return toView(row);
}

export function setEnabled(
  userId: string,
  enabled: boolean,
): Promise<ConnectionView> {
  return updateConnection(userId, { enabled });
}

export function setFieldMapping(
  userId: string,
  mapping: PaperlessFieldMapping,
): Promise<ConnectionView> {
  return updateConnection(userId, { fieldMapping: mapping });
}

export function setBillSourceRow(
  userId: string,
  source: PaperlessBillSource,
): Promise<ConnectionView> {
  return updateConnection(userId, {
    billSource: source,
    // A different source means a different document set: start over.
    lastSyncModified: null,
  });
}

export async function recordConnectionState(
  row: Pick<ConnectionRow, "id" | "userId">,
  patch: Partial<
    Pick<
      ConnectionRow,
      | "lastError"
      | "lastSyncAt"
      | "lastSyncModified"
      | "apiVersion"
      | "serverVersion"
    >
  >,
): Promise<void> {
  await getDB()
    .update(paperlessConnections)
    .set(patch)
    .where(
      and(
        eq(paperlessConnections.userId, row.userId),
        eq(paperlessConnections.id, row.id),
      ),
    );
}

export async function clientForRow(
  row: ConnectionRow,
  options: { timeoutMs?: number } = {},
): Promise<PaperlessClient> {
  let token: string;
  try {
    token = decryptSecret(row.tokenEncrypted);
  } catch (err) {
    if (err instanceof SecretUnreadableError) {
      throw new PaperlessError("token_unreadable", { cause: err });
    }
    throw err;
  }
  return new PaperlessClient({
    ...options,
    baseUrl: row.baseUrl,
    token,
    allowInsecureTls: row.allowInsecureTls,
    apiVersion: row.apiVersion,
    guard: privateNetworkGuard(await privateNetworkAllowedForUser(row.userId)),
  });
}

/** The request guard for a client: none when private hosts are allowed, else a resolve-and-check. */
export function privateNetworkGuard(
  allowPrivate: boolean,
): ((url: string) => Promise<void>) | undefined {
  if (allowPrivate) return undefined;
  return async (url) => {
    try {
      await assertHostAllowed(url, { allowPrivate: false });
    } catch (err) {
      if (!(err instanceof PrivateNetworkError)) throw err;
      throw new PaperlessError(
        err.code === "dns" ? "network" : "blocked_address",
      );
    }
  };
}

/** Stores what a call learned about the server (negotiated API version, release). */
export async function rememberServerInfo(
  row: ConnectionRow,
  client: PaperlessClient,
): Promise<void> {
  const serverVersion = client.serverInfo.serverVersion ?? row.serverVersion;
  if (
    client.apiVersion !== row.apiVersion ||
    serverVersion !== row.serverVersion
  ) {
    await recordConnectionState(row, {
      apiVersion: client.apiVersion,
      serverVersion,
    });
  }
}

export async function getClient(
  userId: string,
  options: { timeoutMs?: number } = {},
): Promise<{
  row: ConnectionRow;
  client: PaperlessClient;
}> {
  const row = await requireConnectionRow(userId);
  return { row, client: await clientForRow(row, options) };
}

function parseVersion(v: string): number[] {
  return v
    .split(/[.+-]/)
    .slice(0, 3)
    .map((p) => Number.parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

export function isOlderThan(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** A reachable server answers at once; do not make the user wait the full request timeout. */
const TEST_TIMEOUT_MS = 5_000;

export interface TestResult {
  serverVersion: string | null;
  apiVersion: number;
  maxApiVersion: number | null;
  warnings: string[];
}

const idOnly = z.object({ id: z.number().int() });

/** Calls the server once, records its version and reports what is worth knowing. */
export async function testConnection(userId: string): Promise<TestResult> {
  const { row, client } = await getClient(userId, {
    timeoutMs: TEST_TIMEOUT_MS,
  });
  try {
    await client.json("documents", pageSchema(idOnly), {
      query: { page_size: 1, fields: "id" },
    });
  } catch (err) {
    await recordConnectionState(row, { lastError: errorCode(err) });
    throw err;
  }
  await rememberServerInfo(row, client);
  await recordConnectionState(row, { lastError: null });
  const { serverVersion, maxApiVersion } = client.serverInfo;
  const warnings: string[] = [];
  if (serverVersion === null) {
    warnings.push(
      "The server did not report its version. Kept needs Paperless-ngx 2.16 or newer.",
    );
  } else if (isOlderThan(serverVersion, MIN_PAPERLESS_VERSION)) {
    warnings.push(
      `Paperless-ngx ${serverVersion} is older than ${MIN_PAPERLESS_VERSION}. Some features may not work.`,
    );
  }
  return {
    serverVersion,
    apiVersion: client.apiVersion,
    maxApiVersion,
    warnings,
  };
}

const tagSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  document_count: z.number().nullish(),
});

export interface TagOption {
  id: number;
  name: string;
  documentCount: number | null;
}

async function collect<T>(pages: AsyncGenerator<T[]>): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages) out.push(...page);
  return out;
}

export async function listTags(userId: string): Promise<TagOption[]> {
  const { row, client } = await getClient(userId);
  const tags = await collect(
    client.pages("tags", { ordering: "name", page_size: 100 }, tagSchema),
  );
  await rememberServerInfo(row, client);
  return tags.map((t) => ({
    id: t.id,
    name: t.name,
    documentCount: t.document_count ?? null,
  }));
}

const savedViewSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  filter_rules: z.array(savedViewRuleSchema).default([]),
});

export interface SavedViewOption {
  id: number;
  name: string;
  /** False when a filter rule of the view cannot be applied by Kept. */
  supported: boolean;
  problem: string | null;
}

function describeView(v: z.output<typeof savedViewSchema>): SavedViewOption {
  const t = translateFilterRules(v.filter_rules);
  return {
    id: v.id,
    name: v.name,
    supported: t.ok,
    problem: t.ok ? null : t.message,
  };
}

export async function listSavedViews(
  userId: string,
): Promise<SavedViewOption[]> {
  const { row, client } = await getClient(userId);
  const views = await collect(
    client.pages("saved_views", { page_size: 100 }, savedViewSchema),
  );
  await rememberServerInfo(row, client);
  return views.map(describeView);
}

export interface CustomFieldOption {
  id: number;
  name: string;
  dataType: string;
  options: Array<{ id: string; label: string }>;
}

const customFieldSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  data_type: z.string(),
  extra_data: z
    .object({
      select_options: z
        .array(z.object({ id: z.string(), label: z.string() }))
        .catch([])
        .nullish(),
    })
    .nullish(),
});

/** A 403 surfaces as `PaperlessError("forbidden")`; the UI then offers manual field ids. */
export async function listCustomFields(
  userId: string,
): Promise<CustomFieldOption[]> {
  const { row, client } = await getClient(userId);
  const fields = await collect(
    client.pages("custom_fields", { page_size: 100 }, customFieldSchema),
  );
  await rememberServerInfo(row, client);
  return fields.map((f) => ({
    id: f.id,
    name: f.name,
    dataType: f.data_type,
    options: f.extra_data?.select_options ?? [],
  }));
}

/** Resolves a tag or saved view by id, returning its name (and the translation for views). */
export async function resolveSource(
  userId: string,
  kind: PaperlessBillSource["kind"],
  id: number,
): Promise<{ label: string; translation: Translation | null }> {
  const { row, client } = await getClient(userId);
  if (kind === "tag") {
    const tag = await client.json(`tags/${id}`, tagSchema);
    await rememberServerInfo(row, client);
    return { label: tag.name, translation: null };
  }
  const view = await client.json(`saved_views/${id}`, savedViewSchema);
  await rememberServerInfo(row, client);
  return {
    label: view.name,
    translation: translateFilterRules(view.filter_rules),
  };
}
