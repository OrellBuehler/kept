import { authEvents, getDB, type AuthEventType } from "$lib/server/db";

/** Records a security event. Callers pass ids only, never secrets, codes or credentials. */
export function logAuthEvent(
  type: AuthEventType,
  userId: string,
  actorId: string = userId,
): void {
  getDB().insert(authEvents).values({ type, userId, actorId }).run();
  console.info(JSON.stringify({ event: `auth.${type}`, userId, actorId }));
}
