import { authEvents, getDB, type AuthEventType } from "$lib/server/db";

/** The insert of a security event as an unexecuted query, so a synchronous transaction body can `.run()` it. */
export function authEventInsert(
  db: Pick<ReturnType<typeof getDB>, "insert">,
  type: AuthEventType,
  userId: string,
  actorId: string,
) {
  return db.insert(authEvents).values({ type, userId, actorId });
}

function logEvent(type: AuthEventType, userId: string, actorId: string): void {
  console.info(JSON.stringify({ event: `auth.${type}`, userId, actorId }));
}

/** Records a security event. Callers pass ids only, never secrets, codes or credentials. */
export async function logAuthEvent(
  type: AuthEventType,
  userId: string,
  actorId: string = userId,
): Promise<void> {
  await authEventInsert(getDB(), type, userId, actorId);
  logEvent(type, userId, actorId);
}

/** Sync twin for the body of a transaction: the row commits or rolls back with it. */
export function logAuthEventInTx(
  tx: Pick<ReturnType<typeof getDB>, "insert">,
  type: AuthEventType,
  userId: string,
  actorId: string = userId,
): void {
  authEventInsert(tx, type, userId, actorId).run();
  logEvent(type, userId, actorId);
}
