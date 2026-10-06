import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { API_SCOPES, API_TOKEN_PREFIX, type ApiScope } from "$lib/api-tokens";
import {
  apiTokens,
  categories,
  first,
  getDB,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { logAuthEventInTx } from "./events";
import { hashToken } from "./sessions";

export const MAX_ACTIVE_TOKENS = 25;
export const MAX_TOKEN_CATEGORIES = 100;
export const TOKEN_NAME_MAX = 64;
/** `lastUsedAt` is written at most this often per token. */
export const LAST_USED_THROTTLE_MS = 60_000;
/** Longest an expiry may lie in the future. */
export const MAX_TOKEN_LIFETIME_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const PREFIX_LENGTH = API_TOKEN_PREFIX.length + 6;
/** A token is `kept_` plus 43 base64url characters; anything much longer is not worth hashing. */
const MAX_TOKEN_LENGTH = 128;

export const createApiTokenSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Enter a name for the token.")
      .max(
        TOKEN_NAME_MAX,
        `Name must be at most ${TOKEN_NAME_MAX} characters.`,
      ),
    scopes: z
      .array(z.enum(API_SCOPES))
      .min(1, "Choose at least one permission.")
      .transform((s) => API_SCOPES.filter((scope) => s.includes(scope))),
    /** Null: all categories. An empty list is refused, never read as "all". */
    categoryIds: z
      .array(z.string().min(1).max(64))
      .min(1, "Choose at least one category.")
      .max(MAX_TOKEN_CATEGORIES)
      .nullable()
      .transform((ids) => (ids ? [...new Set(ids)] : null)),
    expiresAt: z.date().nullable(),
  })
  .refine(
    (v) => v.categoryIds === null || !v.scopes.includes("recurring:read"),
    {
      path: ["scopes"],
      message:
        "A token limited to categories cannot read recurring payments: they are detected across all categories.",
    },
  );
export type CreateApiTokenInput = z.input<typeof createApiTokenSchema>;

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  categoryIds: string[] | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

/** What the request handlers need to know about the token that authenticated a request. */
export interface ApiTokenAuth {
  id: string;
  userId: string;
  scopes: ApiScope[];
  categoryIds: string[] | null;
}

type Row = typeof apiTokens.$inferSelect;

function toInfo(row: Row): ApiTokenInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    categoryIds: row.categoryIds,
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
    expiresAt: row.expiresAt?.getTime() ?? null,
    revokedAt: row.revokedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

function generateToken(): string {
  return (
    API_TOKEN_PREFIX +
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64url",
    )
  );
}

/**
 * Creates a token and returns its plaintext, which exists nowhere else: only
 * its hash is stored. The category restriction must name the user's own
 * categories.
 */
export async function createApiToken(
  userId: string,
  input: z.output<typeof createApiTokenSchema>,
  now: number = Date.now(),
): Promise<{ token: string; info: ApiTokenInfo }> {
  if (input.expiresAt !== null) {
    const at = input.expiresAt.getTime();
    if (at <= now) {
      throw new LedgerError(
        "invalid",
        "The expiry must be in the future.",
        "expires",
      );
    }
    if (at > now + MAX_TOKEN_LIFETIME_MS) {
      throw new LedgerError(
        "invalid",
        "The expiry must be within five years.",
        "expires",
      );
    }
  }
  const token = generateToken();
  const row = await transaction(
    async (tx) => {
      const active = await tx
        .select({ id: apiTokens.id, expiresAt: apiTokens.expiresAt })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
      const live = active.filter(
        (t) => t.expiresAt === null || t.expiresAt.getTime() > now,
      );
      if (live.length >= MAX_ACTIVE_TOKENS) {
        throw new LedgerError(
          "invalid",
          `You can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`,
        );
      }
      if (input.categoryIds !== null) {
        const owned = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              eq(categories.userId, userId),
              inArray(categories.id, input.categoryIds),
            ),
          );
        if (owned.length !== input.categoryIds.length) {
          throw new LedgerError(
            "invalid",
            "Choose your own categories.",
            "categoryIds",
          );
        }
      }
      const created = (await first(
        tx
          .insert(apiTokens)
          .values({
            userId,
            name: input.name,
            tokenHash: hashToken(token),
            prefix: token.slice(0, PREFIX_LENGTH),
            scopes: input.scopes,
            categoryIds: input.categoryIds,
            expiresAt: input.expiresAt,
          })
          .returning(),
      ))!;
      await logAuthEventInTx(tx, "api_token_created", userId);
      return created;
    },
    { lock: `api-tokens:${userId}` },
  );
  return { token, info: toInfo(row) };
}

/** The user's tokens, newest first, revoked and expired ones included. */
export async function listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
  const rows = await getDB()
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt), asc(apiTokens.id));
  return rows.map(toInfo);
}

/** Revoking is permanent and idempotent; another user's token is "not found". */
export async function revokeApiToken(
  userId: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await transaction(async (tx) => {
    const row = await first(
      tx
        .select({ id: apiTokens.id, revokedAt: apiTokens.revokedAt })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, userId), eq(apiTokens.id, id)))
        .limit(1),
    );
    if (!row) throw notFound("Token");
    if (row.revokedAt !== null) return;
    await tx
      .update(apiTokens)
      .set({ revokedAt: new Date(now) })
      .where(and(eq(apiTokens.userId, userId), eq(apiTokens.id, id)));
    await logAuthEventInTx(tx, "api_token_revoked", userId);
  });
}

export type ApiTokenFailure = "invalid" | "revoked" | "expired";

export type VerifiedApiToken =
  { ok: true; token: ApiTokenAuth } | { ok: false; reason: ApiTokenFailure };

/**
 * Looks a presented token up by its hash. Revoked and expired tokens are
 * refused. `lastUsedAt` is refreshed at most once per LAST_USED_THROTTLE_MS.
 */
export async function verifyApiToken(
  presented: string,
  now: number = Date.now(),
): Promise<VerifiedApiToken> {
  if (
    !presented.startsWith(API_TOKEN_PREFIX) ||
    presented.length > MAX_TOKEN_LENGTH
  ) {
    return { ok: false, reason: "invalid" };
  }
  const db = getDB();
  const row = await first(
    db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashToken(presented)))
      .limit(1),
  );
  if (!row) return { ok: false, reason: "invalid" };
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now) {
    return { ok: false, reason: "expired" };
  }
  const stale = new Date(now - LAST_USED_THROTTLE_MS);
  if (row.lastUsedAt === null || row.lastUsedAt.getTime() <= stale.getTime()) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(
        and(
          eq(apiTokens.id, row.id),
          or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, stale)),
        ),
      );
  }
  return {
    ok: true,
    token: {
      id: row.id,
      userId: row.userId,
      scopes: row.scopes,
      categoryIds: row.categoryIds,
    },
  };
}
