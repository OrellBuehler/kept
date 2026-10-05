import type { Database } from "bun:sqlite";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type * as schema from "../schema";

/**
 * The query surface application code gets. `transaction`/`batch` are replaced
 * by the facade's `transaction()`, and the raw `run/all/get/values` shortcuts
 * are left out so every query is a builder that is awaited.
 */
export type DB = Omit<
  SqliteRemoteDatabase<typeof schema>,
  "transaction" | "batch" | "run" | "all" | "get" | "values" | "$cache"
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
