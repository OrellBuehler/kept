/**
 * Generic in-process event bus. The core emits; optional integrations subscribe
 * at startup. A listener failing never affects the operation that emitted.
 */
import { describeError } from "$lib/server/errors";

export type BillChangedListener = (
  userId: string,
  billId: string,
) => void | Promise<void>;

const billChanged = new Set<BillChangedListener>();

/** Subscribes to bill changes; returns an unsubscribe function. */
export function onBillChanged(listener: BillChangedListener): () => void {
  billChanged.add(listener);
  return () => billChanged.delete(listener);
}

/**
 * Announces that a bill, its status or its allocations changed. Listeners run
 * detached (sync errors and rejected promises are caught and logged by code only).
 */
export function emitBillChanged(userId: string, billId: string): void {
  for (const listener of [...billChanged]) {
    try {
      const result = listener(userId, billId);
      if (result instanceof Promise) {
        result.catch((err) =>
          console.error("bill-changed listener failed", describeError(err)),
        );
      }
    } catch (err) {
      console.error("bill-changed listener failed", describeError(err));
    }
  }
}

/** Tests only. */
export function clearEventListeners(): void {
  billChanged.clear();
}
