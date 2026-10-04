import { and, desc, eq, gt } from "drizzle-orm";
import {
  adminAuditLog,
  getDB,
  type AdminAction,
  type UserRole,
} from "$lib/server/db";
import { WINDOW_MS } from "./rate-limit";
import { AuthError } from "./types";

export const AUDIT_LOG_PAGE_SIZE = 20;

interface Person {
  id: string;
  username: string;
}

export interface AdminAuditEntry {
  id: string;
  action: AdminAction;
  actorUsername: string;
  targetUsername: string | null;
  details: string | null;
  createdAt: Date;
}

type AuditDb = Pick<ReturnType<typeof getDB>, "insert">;

function auditInsert(
  db: AuditDb,
  actor: Person,
  action: AdminAction,
  opts: { target?: Person; details?: string },
) {
  return db.insert(adminAuditLog).values({
    actorUserId: actor.id,
    actorUsername: actor.username,
    action,
    targetUserId: opts.target?.id ?? null,
    targetUsername: opts.target?.username ?? null,
    details: opts.details ?? null,
  });
}

function logAction(
  actor: Person,
  action: AdminAction,
  opts: { target?: Person },
): void {
  console.info(
    JSON.stringify({
      event: `admin.${action}`,
      actorId: actor.id,
      targetId: opts.target?.id ?? null,
    }),
  );
}

/** Records an administrator action. Ids, usernames and short context only, never secrets. */
export async function recordAdminAction(
  actor: Person,
  action: AdminAction,
  opts: { target?: Person; details?: string } = {},
): Promise<void> {
  await auditInsert(getDB(), actor, action, opts);
  logAction(actor, action, opts);
}

/**
 * Sync twin for the body of the action's own transaction, so the change and its
 * audit row commit together.
 */
export function recordAdminActionInTx(
  tx: AuditDb,
  actor: Person,
  action: AdminAction,
  opts: { target?: Person; details?: string } = {},
): void {
  auditInsert(tx, actor, action, opts).run();
  logAction(actor, action, opts);
}

/**
 * A confirmation attempt was refused for being over the rate limit. Written at
 * most once per limiter window per administrator so a flood cannot fill the table.
 * The look-up and the insert share one synchronous transaction: with an await in
 * between, parallel refusals would all see "none yet" and all write.
 */
export async function recordConfirmationRateLimited(
  actor: Person,
  now: number = Date.now(),
): Promise<void> {
  const written = getDB().transaction(
    (tx) => {
      const recent = tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.actorUserId, actor.id),
            eq(adminAuditLog.action, "admin_confirm_rate_limited"),
            gt(adminAuditLog.createdAt, new Date(now - WINDOW_MS)),
          ),
        )
        .limit(1)
        .get();
      if (recent) return false;
      auditInsert(tx, actor, "admin_confirm_rate_limited", {}).run();
      return true;
    },
    { behavior: "immediate" },
  );
  if (written) logAction(actor, "admin_confirm_rate_limited", {});
}

/** Newest first. Administrators only; any other caller gets an AuthError. */
export async function listAdminAuditLog(
  actor: { role: UserRole },
  limit: number = AUDIT_LOG_PAGE_SIZE,
): Promise<AdminAuditEntry[]> {
  if (actor.role !== "admin") {
    throw new AuthError("forbidden", "Administrator access required.");
  }
  return await getDB()
    .select({
      id: adminAuditLog.id,
      action: adminAuditLog.action,
      actorUsername: adminAuditLog.actorUsername,
      targetUsername: adminAuditLog.targetUsername,
      details: adminAuditLog.details,
      createdAt: adminAuditLog.createdAt,
    })
    .from(adminAuditLog)
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(limit);
}
