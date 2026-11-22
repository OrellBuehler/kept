import { AsyncLocalStorage } from "node:async_hooks";
import type { ActorKind } from "$lib/server/db/schema";

export type { ActorKind };

/**
 * Who is making the change that is running. `userId` is the signed-in user the
 * request acts for; a system actor (background work) has none, the change log
 * takes the owner of the data from the entry.
 */
export type Actor =
  | {
      kind: Exclude<ActorKind, "system">;
      userId: string;
      /** The api token or mcp connection, when the caller has one. */
      tokenId?: string;
      /** A display snapshot (token or connection name) so the log stays readable after the token is gone. */
      label?: string;
    }
  | { kind: "system"; userId?: string; tokenId?: string; label?: string };

/**
 * Separate from the database's own AsyncLocalStorage (db/index.ts), so neither
 * interferes with the other: `transaction()` bodies and the `afterCommit` hooks
 * it runs (which leave the database's context on purpose) still see the actor.
 */
const store = new AsyncLocalStorage<Actor>();

/** Runs `fn`, and everything it awaits, as `actor`. Nested calls override the outer actor. */
export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return store.run(actor, fn);
}

/** `runAsActor` for background work (watch folder, schedulers, integration sync). */
export function runAsSystem<T>(fn: () => T, label?: string): T {
  return store.run({ kind: "system", label }, fn);
}

/** The actor of the running request or job, or undefined outside both. */
export function currentActor(): Actor | undefined {
  return store.getStore();
}
