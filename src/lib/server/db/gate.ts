/**
 * A strict FIFO gate in front of a single database connection.
 *
 * One connection means one transaction state: a statement run while another
 * caller's transaction is open would land inside it (and be rolled back or
 * committed with it). So both transactions and plain queries pass through the
 * gate. Ownership is handed straight from the releasing owner to the next
 * waiter, with no re-check after the wake-up, so a query that arrives later can
 * never overtake a waiter and slip in between two owners.
 */

export class GateToken {
  active = true;
  readonly stack: string;
  constructor(
    readonly label: string,
    captureStack = false,
  ) {
    this.stack = captureStack
      ? (new Error(`gate owner: ${label}`).stack ?? "")
      : "";
  }
}

export class GateTimeoutError extends Error {
  override readonly name = "DatabaseGateTimeoutError";
  constructor(waitedMs: number) {
    super(
      `Timed out after ${waitedMs}ms waiting for the database; another transaction holds it.`,
    );
  }
}

export class GateResetError extends Error {
  override readonly name = "DatabaseGateResetError";
  constructor() {
    super("The database gate was reset while this request was waiting.");
  }
}

interface Waiter {
  token: GateToken;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Gate {
  #owner: GateToken | null = null;
  #queue: Waiter[] = [];

  constructor(readonly timeoutMs: number) {}

  get owner(): GateToken | null {
    return this.#owner;
  }

  get free(): boolean {
    return this.#owner === null;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /** Takes ownership if nobody holds the gate. A free gate never has waiters. */
  tryAcquire(token: GateToken): boolean {
    if (this.#owner !== null) return false;
    this.#owner = token;
    return true;
  }

  /** Queues behind the current owner and every earlier waiter. */
  acquire(token: GateToken): Promise<void> {
    if (this.tryAcquire(token)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        token,
        resolve,
        reject,
        timer: setTimeout(() => this.#timeOut(waiter), this.timeoutMs),
      };
      this.#queue.push(waiter);
    });
  }

  /** Hands the gate to the longest-waiting caller, or frees it. */
  release(token: GateToken): void {
    if (this.#owner !== token) {
      throw new Error(
        "Database gate released by a caller that does not own it",
      );
    }
    token.active = false;
    const next = this.#queue.shift();
    if (!next) {
      this.#owner = null;
      return;
    }
    clearTimeout(next.timer);
    this.#owner = next.token;
    next.resolve();
  }

  /**
   * Drops the owner and fails every waiter. A test that left a transaction
   * open must not hang the rest of the suite.
   */
  reset(): void {
    if (this.#owner) this.#owner.active = false;
    this.#owner = null;
    const waiters = this.#queue;
    this.#queue = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new GateResetError());
    }
  }

  #timeOut(waiter: Waiter): void {
    const at = this.#queue.indexOf(waiter);
    if (at < 0) return;
    this.#queue.splice(at, 1);
    // The stack shows where the blocking transaction was started, which is the
    // thing to fix; it holds code locations only, never query text or values.
    console.error(
      "database gate wait timed out after %dms (%d still waiting). Owner: %s\n%s",
      this.timeoutMs,
      this.#queue.length,
      this.#owner?.label ?? "none",
      this.#owner?.stack || "(no stack captured)",
    );
    waiter.reject(new GateTimeoutError(this.timeoutMs));
  }
}
