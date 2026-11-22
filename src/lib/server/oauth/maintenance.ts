import { and, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { getDB, mcpConnections, oauthTokens } from "$lib/server/db";
import { startTicker } from "$lib/server/scheduling";
import { sweepAuthorizations } from "./authorize";
import { sweepUnusedClients } from "./clients";
import {
  AUTHORIZATION_RETENTION_MS,
  DEAD_CONNECTION_RETENTION_MS,
  EXPIRED_TOKEN_RETENTION_MS,
} from "./config";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;

/**
 * Housekeeping, hourly: connections whose last usable token has lapsed are
 * marked expired, expired tokens and old requests and codes are deleted,
 * connections that ended long ago leave the settings page, and clients
 * nobody connected through are dropped.
 */
export async function sweepOAuth(now: number = Date.now()): Promise<void> {
  const db = getDB();
  const at = new Date(now);
  await db
    .update(mcpConnections)
    .set({ expiresAt: at })
    .where(
      and(
        isNull(mcpConnections.revokedAt),
        or(isNull(mcpConnections.expiresAt), gt(mcpConnections.expiresAt, at)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(oauthTokens)
            .where(
              and(
                eq(oauthTokens.connectionId, mcpConnections.id),
                gt(oauthTokens.expiresAt, at),
                isNull(oauthTokens.usedAt),
              ),
            ),
        ),
      ),
    );
  await db
    .delete(oauthTokens)
    .where(
      lt(oauthTokens.expiresAt, new Date(now - EXPIRED_TOKEN_RETENTION_MS)),
    );
  await sweepAuthorizations(AUTHORIZATION_RETENTION_MS, now);
  const ended = new Date(now - DEAD_CONNECTION_RETENTION_MS);
  await db
    .delete(mcpConnections)
    .where(
      or(
        lt(mcpConnections.revokedAt, ended),
        lt(mcpConnections.expiresAt, ended),
      ),
    );
  await sweepUnusedClients(now);
}

let stop: (() => void) | null = null;

/** Starts the hourly sweep. Called once from the init hook. */
export function registerOAuthSweep(
  options: { intervalMs?: number; firstRunDelayMs?: number } = {},
): void {
  if (stop) return;
  const stopTicker = startTicker({
    name: "oauth-sweep",
    intervalMs: options.intervalMs ?? SWEEP_INTERVAL_MS,
    firstRunDelayMs: options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS,
    run: () => sweepOAuth(),
  });
  stop = () => {
    stopTicker();
    stop = null;
  };
}

export function unregisterOAuthSweep(): void {
  stop?.();
}
