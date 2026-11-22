import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { ApiScope } from "$lib/api-tokens";
import { logAuthEventInTx } from "$lib/server/auth/events";
import type { CredentialAuth } from "$lib/server/auth/grant";
import {
  first,
  getDB,
  mcpConnections,
  oauthClients,
  oauthTokens,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { MAX_ACTIVE_CONNECTIONS } from "./config";
import { ACCESS_TOKEN_PREFIX, MAX_SECRET_LENGTH, hashSecret } from "./secrets";
import { mcpResourceOf } from "./urls";

/** `lastUsedAt` is written at most this often per connection. */
export const CONNECTION_LAST_USED_THROTTLE_MS = 60_000;
export const CONNECTION_NAME_MAX = 64;

export interface ConnectionInfo {
  id: string;
  name: string;
  /** The name the application registered under (untrusted text). */
  clientName: string;
  scopes: ApiScope[];
  categoryIds: string[] | null;
  accountIds: string[] | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

type Db = Pick<
  ReturnType<typeof getDB>,
  "select" | "update" | "delete" | "insert"
>;

const isAlive = (now: number) =>
  and(
    isNull(mcpConnections.revokedAt),
    or(
      isNull(mcpConnections.expiresAt),
      gt(mcpConnections.expiresAt, new Date(now)),
    ),
  );

/** Connections of the user that are neither revoked nor expired. */
export async function countActiveConnections(
  db: Pick<ReturnType<typeof getDB>, "select">,
  userId: string,
  now: number,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.userId, userId), isAlive(now)));
  return row?.n ?? 0;
}

export function assertConnectionRoom(active: number): void {
  if (active >= MAX_ACTIVE_CONNECTIONS) {
    throw new LedgerError(
      "invalid",
      `You can have at most ${MAX_ACTIVE_CONNECTIONS} connected apps. Revoke one first.`,
    );
  }
}

/** The user's connections, newest first, revoked and expired ones included. */
export async function listConnections(
  userId: string,
): Promise<ConnectionInfo[]> {
  const rows = await getDB()
    .select({
      id: mcpConnections.id,
      name: mcpConnections.name,
      clientName: oauthClients.name,
      scopes: mcpConnections.scopes,
      categoryIds: mcpConnections.categoryIds,
      accountIds: mcpConnections.accountIds,
      lastUsedAt: mcpConnections.lastUsedAt,
      expiresAt: mcpConnections.expiresAt,
      revokedAt: mcpConnections.revokedAt,
      createdAt: mcpConnections.createdAt,
    })
    .from(mcpConnections)
    .innerJoin(oauthClients, eq(oauthClients.id, mcpConnections.clientId))
    .where(eq(mcpConnections.userId, userId))
    .orderBy(desc(mcpConnections.createdAt), asc(mcpConnections.id));
  return rows.map((r) => ({
    ...r,
    lastUsedAt: r.lastUsedAt?.getTime() ?? null,
    expiresAt: r.expiresAt?.getTime() ?? null,
    revokedAt: r.revokedAt?.getTime() ?? null,
    createdAt: r.createdAt.getTime(),
  }));
}

/**
 * Ends a connection inside a transaction: it is marked revoked, and every token
 * checks its connection, so nothing it issued works again (the token rows stay
 * until the connection is swept, so a stale client is told "revoked" rather than
 * "unknown"). Idempotent; returns whether
 * this call revoked it. `actorId` is who did it for the security log: the
 * owner, or the connection itself when its own client revoked it or reused a
 * token.
 */
export async function revokeConnectionInTx(
  tx: Db,
  connectionId: string,
  now: number,
  actorId?: string,
): Promise<boolean> {
  const revoked = await tx
    .update(mcpConnections)
    .set({ revokedAt: new Date(now) })
    .where(
      and(
        eq(mcpConnections.id, connectionId),
        isNull(mcpConnections.revokedAt),
      ),
    )
    .returning({ userId: mcpConnections.userId });
  const row = revoked[0];
  if (!row) return false;
  await logAuthEventInTx(
    tx,
    "mcp_connection_revoked",
    row.userId,
    actorId ?? row.userId,
  );
  return true;
}

/** Revoking is permanent and idempotent; another user's connection is "not found". */
export async function revokeConnection(
  userId: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await transaction(async (tx) => {
    const row = await first(
      tx
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(
          and(eq(mcpConnections.userId, userId), eq(mcpConnections.id, id)),
        ),
    );
    if (!row) throw notFound("Connection");
    await revokeConnectionInTx(tx, id, now, userId);
  });
}

/** The display name shown in the change log from now on; entries already written keep theirs. */
export async function renameConnection(
  userId: string,
  id: string,
  name: string,
): Promise<void> {
  const clean = name.trim();
  if (clean.length === 0 || clean.length > CONNECTION_NAME_MAX) {
    throw new LedgerError(
      "invalid",
      `Enter a name of 1 to ${CONNECTION_NAME_MAX} characters.`,
      "name",
    );
  }
  const updated = await getDB()
    .update(mcpConnections)
    .set({ name: clean })
    .where(and(eq(mcpConnections.userId, userId), eq(mcpConnections.id, id)))
    .returning({ id: mcpConnections.id });
  if (updated.length === 0) throw notFound("Connection");
}

export type ConnectionFailure = "invalid" | "revoked" | "expired";

export type VerifiedConnection =
  | { ok: true; token: CredentialAuth }
  | { ok: false; reason: ConnectionFailure };

/**
 * Looks a presented access token up by its hash. Refused: an unknown or
 * malformed token, an expired token, a revoked or expired connection, and a
 * token issued for another resource than this server's MCP endpoint (its
 * audience). `lastUsedAt` of the connection is refreshed at most once per
 * CONNECTION_LAST_USED_THROTTLE_MS.
 */
export async function verifyAccessToken(
  presented: string,
  requestUrl: URL,
  now: number = Date.now(),
): Promise<VerifiedConnection> {
  if (
    !presented.startsWith(ACCESS_TOKEN_PREFIX) ||
    presented.length > MAX_SECRET_LENGTH
  ) {
    return { ok: false, reason: "invalid" };
  }
  const db = getDB();
  const row = await first(
    db
      .select({
        tokenExpiresAt: oauthTokens.expiresAt,
        id: mcpConnections.id,
        userId: mcpConnections.userId,
        name: mcpConnections.name,
        scopes: mcpConnections.scopes,
        categoryIds: mcpConnections.categoryIds,
        accountIds: mcpConnections.accountIds,
        resource: mcpConnections.resource,
        lastUsedAt: mcpConnections.lastUsedAt,
        expiresAt: mcpConnections.expiresAt,
        revokedAt: mcpConnections.revokedAt,
      })
      .from(oauthTokens)
      .innerJoin(
        mcpConnections,
        eq(mcpConnections.id, oauthTokens.connectionId),
      )
      .where(
        and(
          eq(oauthTokens.tokenHash, hashSecret(presented)),
          eq(oauthTokens.kind, "access"),
        ),
      ),
  );
  if (!row) return { ok: false, reason: "invalid" };
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (
    row.tokenExpiresAt.getTime() <= now ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= now)
  ) {
    return { ok: false, reason: "expired" };
  }
  if (row.resource !== mcpResourceOf(requestUrl)) {
    return { ok: false, reason: "invalid" };
  }
  const stale = new Date(now - CONNECTION_LAST_USED_THROTTLE_MS);
  if (row.lastUsedAt === null || row.lastUsedAt.getTime() <= stale.getTime()) {
    await db
      .update(mcpConnections)
      .set({ lastUsedAt: new Date(now) })
      .where(
        and(
          eq(mcpConnections.id, row.id),
          or(
            isNull(mcpConnections.lastUsedAt),
            lt(mcpConnections.lastUsedAt, stale),
          ),
        ),
      );
  }
  return {
    ok: true,
    token: {
      id: row.id,
      userId: row.userId,
      name: row.name,
      scopes: row.scopes,
      categoryIds: row.categoryIds,
      accountIds: row.accountIds,
    },
  };
}
