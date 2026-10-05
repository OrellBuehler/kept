import { detach } from "$lib/server/detached";
import { readDatabaseConfig } from "$lib/server/db/config";
import { connectionParams } from "$lib/server/db/postgres";
import { describeError } from "$lib/server/errors";

/** Prefix of the advisory-lock keys; distinct from `kept:tx:` and `kept:migrate`. */
const JOB_LOCK_PREFIX = "kept:job:";
/** One connection per concurrently held job lock; there are four scheduled jobs. */
const LOCK_POOL_MAX = 4;

let lockClient: Bun.SQL | null = null;

function lockPool(): Bun.SQL {
  if (lockClient) return lockClient;
  const config = readDatabaseConfig();
  if (config.kind !== "postgres") {
    throw new Error("Job locks need a PostgreSQL database");
  }
  lockClient = new Bun.SQL({
    url: config.url,
    adapter: "postgres",
    max: LOCK_POOL_MAX,
    prepare: config.prepare,
    // A tick may run for minutes and holds its transaction open meanwhile.
    connection: connectionParams(
      { ...config, statementTimeoutMs: 0, transactionTimeoutMs: 0 },
      "-jobs",
    ),
  });
  return lockClient;
}

/**
 * Runs `fn` unless another instance is already running the job `name`.
 * Returns whether it ran. With SQLite there is only ever one instance, so it
 * always runs.
 *
 * On PostgreSQL the lock is a transaction-scoped advisory try-lock on a
 * connection of its own, held for the duration of `fn`: it is released when
 * `fn` ends, and by the server when the instance dies. A transaction (rather
 * than a session lock) stays correct behind a pooler in transaction mode.
 * `fn` does its own queries on the regular pool; it must not need this lock's
 * connection.
 */
export async function runExclusive(
  name: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (readDatabaseConfig().kind !== "postgres") {
    await fn();
    return true;
  }
  let ran = false;
  await lockPool().begin(async (sql) => {
    // A server-side idle-in-transaction timeout would end the transaction, and
    // so drop the lock, while `fn` works on other connections.
    await sql.unsafe("set local idle_in_transaction_session_timeout = 0");
    const rows = (await sql.unsafe(
      "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
      [`${JOB_LOCK_PREFIX}${name}`],
    )) as { locked: boolean }[];
    if (!rows[0]?.locked) return;
    ran = true;
    await fn();
  });
  return ran;
}

/** Closes the lock connections. Called on shutdown, after the jobs have stopped. */
export async function closeJobLocks(): Promise<void> {
  const client = lockClient;
  lockClient = null;
  await client?.close({ timeout: 0 });
}

export interface TickerOptions {
  /** Names the job in logs and in its lock key. */
  name: string;
  intervalMs: number;
  firstRunDelayMs: number;
  run: () => Promise<void>;
}

/**
 * Runs `run` after `firstRunDelayMs` and then every `intervalMs`, on one
 * instance at a time and never overlapping itself. A failing tick is logged by
 * code only; the next one still runs. Returns a function that stops the timers
 * (a tick already running finishes).
 */
export function startTicker(options: TickerOptions): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runExclusive(options.name, options.run);
    } catch (err) {
      console.error("%s tick failed: %s", options.name, describeError(err));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => detach(tick()), options.firstRunDelayMs);
  const timer = setInterval(() => detach(tick()), options.intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
