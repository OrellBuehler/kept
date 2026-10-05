import type { Database } from "bun:sqlite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * The query surface application code gets, typed as pg-core: the schema is
 * written once against the dialect-switched builders, and the process holds
 * either a genuine sqlite or a genuine pg database behind this type. That
 * leaves only the subset of drizzle that works on both; lint bans the pg-only
 * calls the type would still allow.
 *
 * `transaction` is replaced by the facade's `transaction()`. `execute`,
 * `selectDistinctOn` and `refreshMaterializedView` do not exist on SQLite.
 */
export type DB = Omit<
  PgDatabase<PgQueryResultHKT, typeof schema>,
  | "transaction"
  | "execute"
  | "selectDistinctOn"
  | "refreshMaterializedView"
  | "$cache"
>;

export interface BackendTransaction {
  /** Queries on this instance run inside the transaction and nowhere else. */
  readonly db: DB;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
  rollbackToSavepoint(name: string): Promise<void>;
  /** Ends the transaction's hold on the connection. Always called exactly once. */
  release(): void;
}

export interface Backend {
  /** Plain queries: serialised behind any open transaction. */
  readonly root: DB;
  beginTransaction(): Promise<BackendTransaction>;
  /** Raw access to the connection while nothing else uses it. */
  withExclusiveClient<T>(fn: (client: Database) => T | Promise<T>): Promise<T>;
  /** Fails queued callers and forgets the owner. Tests only. */
  resetGate(): void;
  close(): Promise<void>;
}
