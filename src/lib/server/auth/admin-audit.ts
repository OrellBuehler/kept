import { desc } from "drizzle-orm";
import {
  adminAuditLog,
  getDB,
  type AdminAction,
  type UserRole,
} from "$lib/server/db";
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

/** Records an administrator action. Ids, usernames and short context only, never secrets. */
export function recordAdminAction(
  actor: Person,
  action: AdminAction,
  opts: { target?: Person; details?: string } = {},
): void {
  getDB()
    .insert(adminAuditLog)
    .values({
      actorUserId: actor.id,
      actorUsername: actor.username,
      action,
      targetUserId: opts.target?.id ?? null,
      targetUsername: opts.target?.username ?? null,
      details: opts.details ?? null,
    })
    .run();
  console.info(
    JSON.stringify({
      event: `admin.${action}`,
      actorId: actor.id,
      targetId: opts.target?.id ?? null,
    }),
  );
}

/** Newest first. Administrators only; any other caller gets an AuthError. */
export function listAdminAuditLog(
  actor: { role: UserRole },
  limit: number = AUDIT_LOG_PAGE_SIZE,
): AdminAuditEntry[] {
  if (actor.role !== "admin") {
    throw new AuthError("forbidden", "Administrator access required.");
  }
  return getDB()
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
    .limit(limit)
    .all();
}
