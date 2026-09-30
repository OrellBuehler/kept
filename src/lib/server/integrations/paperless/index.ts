import { onBillChanged } from "$lib/server/events";
import { pushBillSafely } from "./push";
import { startScheduler } from "./scheduler";

let stop: (() => void) | null = null;

/**
 * Wires the adapter into the app: pushes bill changes to Paperless and starts
 * the periodic catch-up sync. Called once from the server's init hook.
 */
export function registerPaperless(): void {
  if (stop) return;
  const unsubscribe = onBillChanged(async (userId, billId) => {
    await pushBillSafely(userId, billId);
  });
  const stopScheduler = startScheduler();
  stop = () => {
    unsubscribe();
    stopScheduler();
    stop = null;
  };
}

/** Tests only. */
export function unregisterPaperless(): void {
  stop?.();
}
