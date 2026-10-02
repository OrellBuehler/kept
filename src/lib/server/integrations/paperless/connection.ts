import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "$lib/server/crypto";
import {
  getDB,
  paperlessConnections,
  paperlessDismissed,
  paperlessDocuments,
  type PaperlessBillSource,
  type PaperlessFieldMapping,
} from "$lib/server/db";
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

export function isDismissed(userId: string, ref: string): boolean {
  const found = getDB()
    .select({ id: paperlessDismissed.id })
    .from(paperlessDismissed)
    .where(
      and(
        eq(paperlessDismissed.userId, userId),
        eq(paperlessDismissed.externalRef, ref),
      ),
    )
    .get();
  return found !== undefined;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDB>["transaction"]>[0]>[0];

/** Before link rows go away: keeps the documents whose bill the user deleted from coming back. */
function rememberDismissed(tx: Tx, row: ConnectionRow): void {
  const dismissed = tx
    .select({ paperlessId: paperlessDocuments.paperlessId })
    .from(paperlessDocuments)
    .where(
      and(
        eq(paperlessDocuments.userId, row.userId),
        eq(paperlessDocuments.connectionId, row.id),
        eq(paperlessDocuments.status, "imported"),
        isNull(paperlessDocuments.billId),
      ),
    )
    .all();
  if (dismissed.length === 0) return;
  tx.insert(paperlessDismissed)
    .values(
      dismissed.map((d) => ({
        userId: row.userId,
        externalRef: externalRef(row.baseUrl, d.paperlessId),
      })),
    )
    .onConflictDoNothing()
    .run();
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
  createdAt: number;
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

const newWebhookToken = () => randomBytes(24).toString("base64url");
const newWebhookSecret = () => randomBytes(32).toString("base64url");

export function getConnectionRow(userId: string): ConnectionRow | null {
  return (
    getDB()
      .select()
      .from(paperlessConnections)
      .where(eq(paperlessConnections.userId, userId))
      .get() ?? null
  );
}

export function getConnection(userId: string): ConnectionView | null {
  const row = getConnectionRow(userId);
  return row ? toView(row) : null;
}

export function hasPaperlessConnection(userId: string): boolean {
  return getConnectionRow(userId) !== null;
}

export function requireConnectionRow(userId: string): ConnectionRow {
  const row = getConnectionRow(userId);
  if (!row) throw notFound("Paperless connection");
  return row;
}

/** The connection a webhook URL token belongs to (public endpoint; no user context yet). */
export function getConnectionByWebhookToken(
  token: string,
): ConnectionRow | null {
  return (
    getDB()
      .select()
      .from(paperlessConnections)
      .where(eq(paperlessConnections.webhookToken, token))
      .get() ?? null
  );
}

export function listEnabledConnections(): ConnectionRow[] {
  return getDB()
    .select()
    .from(paperlessConnections)
    .where(eq(paperlessConnections.enabled, true))
    .all();
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
}

export interface SaveConnectionResult {
  connection: ConnectionView;
  /** Plain webhook secret; only present when the connection was just created. */
  webhookSecret: string | null;
}

/** Creates the user's connection or updates it (one per user). */
export function saveConnection(
  userId: string,
  input: SaveConnectionInput,
): SaveConnectionResult {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl);
  } catch (err) {
    if (err instanceof PaperlessError) {
      throw new LedgerError("invalid", err.message, "baseUrl");
    }
    throw err;
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
  const db = getDB();
  const existing = getConnectionRow(userId);

  if (!existing) {
    if (token === null) {
      throw new LedgerError("invalid", "Enter the access token.", "token");
    }
    const secret = newWebhookSecret();
    const row = db
      .insert(paperlessConnections)
      .values({
        userId,
        baseUrl,
        tokenEncrypted: encryptSecret(token),
        allowInsecureTls: input.allowInsecureTls,
        webhookSecretHash: hashSecret(secret),
        webhookToken: newWebhookToken(),
      })
      .returning()
      .get();
    return { connection: toView(row), webhookSecret: secret };
  }

  const moved = existing.baseUrl !== baseUrl;
  const row = db.transaction((tx) => {
    if (moved) {
      // Another server has other document ids: old links and watermark are meaningless.
      rememberDismissed(tx, existing);
      tx.delete(paperlessDocuments)
        .where(
          and(
            eq(paperlessDocuments.userId, userId),
            eq(paperlessDocuments.connectionId, existing.id),
          ),
        )
        .run();
    }
    return tx
      .update(paperlessConnections)
      .set({
        baseUrl,
        allowInsecureTls: input.allowInsecureTls,
        ...(token !== null ? { tokenEncrypted: encryptSecret(token) } : {}),
        ...(moved
          ? {
              apiVersion: null,
              serverVersion: null,
              lastSyncModified: null,
              lastSyncAt: null,
            }
          : {}),
        ...(moved || token !== null ? { lastError: null } : {}),
      })
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, existing.id),
        ),
      )
      .returning()
      .get();
  });
  return { connection: toView(row), webhookSecret: null };
}

/** Replaces the webhook secret; the old one stops working immediately. */
export function rotateWebhookSecret(userId: string): string {
  const row = requireConnectionRow(userId);
  const secret = newWebhookSecret();
  getDB()
    .update(paperlessConnections)
    .set({ webhookSecretHash: hashSecret(secret) })
    .where(
      and(
        eq(paperlessConnections.userId, userId),
        eq(paperlessConnections.id, row.id),
      ),
    )
    .run();
  return secret;
}

/** Removes the connection and its link rows. Bills and their stored documents stay. */
export function deleteConnection(userId: string): void {
  const row = requireConnectionRow(userId);
  getDB().transaction((tx) => {
    rememberDismissed(tx, row);
    tx.delete(paperlessConnections)
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, row.id),
        ),
      )
      .run();
  });
}

export function setEnabled(userId: string, enabled: boolean): ConnectionView {
  const row = requireConnectionRow(userId);
  return toView(
    getDB()
      .update(paperlessConnections)
      .set({ enabled })
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, row.id),
        ),
      )
      .returning()
      .get(),
  );
}

export function setFieldMapping(
  userId: string,
  mapping: PaperlessFieldMapping,
): ConnectionView {
  const row = requireConnectionRow(userId);
  return toView(
    getDB()
      .update(paperlessConnections)
      .set({ fieldMapping: mapping })
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, row.id),
        ),
      )
      .returning()
      .get(),
  );
}

export function setBillSourceRow(
  userId: string,
  source: PaperlessBillSource,
): ConnectionView {
  const row = requireConnectionRow(userId);
  return toView(
    getDB()
      .update(paperlessConnections)
      .set({
        billSource: source,
        // A different source means a different document set: start over.
        lastSyncModified: null,
      })
      .where(
        and(
          eq(paperlessConnections.userId, userId),
          eq(paperlessConnections.id, row.id),
        ),
      )
      .returning()
      .get(),
  );
}

export function recordConnectionState(
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
): void {
  getDB()
    .update(paperlessConnections)
    .set(patch)
    .where(
      and(
        eq(paperlessConnections.userId, row.userId),
        eq(paperlessConnections.id, row.id),
      ),
    )
    .run();
}

export function clientForRow(
  row: ConnectionRow,
  options: { timeoutMs?: number } = {},
): PaperlessClient {
  return new PaperlessClient({
    ...options,
    baseUrl: row.baseUrl,
    token: decryptSecret(row.tokenEncrypted),
    allowInsecureTls: row.allowInsecureTls,
    apiVersion: row.apiVersion,
  });
}

/** Stores what a call learned about the server (negotiated API version, release). */
export function rememberServerInfo(
  row: ConnectionRow,
  client: PaperlessClient,
): void {
  const serverVersion = client.serverInfo.serverVersion ?? row.serverVersion;
  if (
    client.apiVersion !== row.apiVersion ||
    serverVersion !== row.serverVersion
  ) {
    recordConnectionState(row, {
      apiVersion: client.apiVersion,
      serverVersion,
    });
  }
}

export function getClient(
  userId: string,
  options: { timeoutMs?: number } = {},
): {
  row: ConnectionRow;
  client: PaperlessClient;
} {
  const row = requireConnectionRow(userId);
  return { row, client: clientForRow(row, options) };
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
  const { row, client } = getClient(userId, { timeoutMs: TEST_TIMEOUT_MS });
  try {
    await client.json("documents", pageSchema(idOnly), {
      query: { page_size: 1, fields: "id" },
    });
  } catch (err) {
    recordConnectionState(row, { lastError: errorCode(err) });
    throw err;
  }
  rememberServerInfo(row, client);
  recordConnectionState(row, { lastError: null });
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
  const { row, client } = getClient(userId);
  const tags = await collect(
    client.pages("tags", { ordering: "name", page_size: 100 }, tagSchema),
  );
  rememberServerInfo(row, client);
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
  const { row, client } = getClient(userId);
  const views = await collect(
    client.pages("saved_views", { page_size: 100 }, savedViewSchema),
  );
  rememberServerInfo(row, client);
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
  const { row, client } = getClient(userId);
  const fields = await collect(
    client.pages("custom_fields", { page_size: 100 }, customFieldSchema),
  );
  rememberServerInfo(row, client);
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
  const { row, client } = getClient(userId);
  if (kind === "tag") {
    const tag = await client.json(`tags/${id}`, tagSchema);
    rememberServerInfo(row, client);
    return { label: tag.name, translation: null };
  }
  const view = await client.json(`saved_views/${id}`, savedViewSchema);
  rememberServerInfo(row, client);
  return {
    label: view.name,
    translation: translateFilterRules(view.filter_rules),
  };
}
