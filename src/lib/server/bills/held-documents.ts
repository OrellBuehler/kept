import { and, asc, eq, exists, lte, notExists, sql } from "drizzle-orm";
import { bills, documents, getDB } from "$lib/server/db";
import { currentActor } from "$lib/server/audit/context";
import { startTicker } from "$lib/server/scheduling";
import { deleteDocumentWhere } from "./documents";

/**
 * How long the uploaded document of a bill deleted through the API or MCP is
 * kept, so that reverting the delete in the change log gets the document back.
 */
export const HELD_DOCUMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether the bill delete that is running was made by a connection (an API
 * token or an MCP connection) rather than by the owner at the screen. What an
 * assistant does must be revertible in full, so it never destroys the file;
 * the owner's own delete keeps removing it at once.
 */
export function holdsDocumentOnDelete(): boolean {
  const kind = currentActor()?.kind;
  return kind === "mcp" || kind === "api";
}

const referencing = () =>
  getDB()
    .select({ one: sql`1` })
    .from(bills)
    .where(eq(bills.documentId, documents.id));

/** A document no bill references. */
const unreferenced = () => notExists(referencing());

const BATCH = 200;

/**
 * Removes the held documents whose time is up and that no bill references.
 * A document a bill references again (reverted delete, or the same file
 * uploaded since) is never deleted: the reference check is part of the delete
 * statement, and its hold is lifted. Returns how many were removed.
 */
export async function sweepHeldDocuments(
  now: number = Date.now(),
): Promise<number> {
  const due = lte(documents.heldUntil, new Date(now));
  await getDB()
    .update(documents)
    .set({ heldUntil: null })
    .where(and(due, exists(referencing())));
  const stale = await getDB()
    .select({ id: documents.id, userId: documents.userId })
    .from(documents)
    .where(and(due, eq(documents.source, "upload"), unreferenced()))
    .orderBy(asc(documents.heldUntil), asc(documents.id))
    .limit(BATCH);
  let removed = 0;
  for (const d of stale) {
    if (
      await deleteDocumentWhere(
        d.userId,
        d.id,
        and(due, eq(documents.source, "upload"), unreferenced()),
      )
    ) {
      removed++;
    }
  }
  return removed;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60_000;

let stop: (() => void) | null = null;

/** Starts the hourly sweep of held documents. Called once from the init hook. */
export function registerHeldDocumentSweep(
  options: { intervalMs?: number; firstRunDelayMs?: number } = {},
): void {
  if (stop) return;
  const stopTicker = startTicker({
    name: "held document sweep",
    intervalMs: options.intervalMs ?? SWEEP_INTERVAL_MS,
    firstRunDelayMs: options.firstRunDelayMs ?? FIRST_RUN_DELAY_MS,
    run: async () => {
      await sweepHeldDocuments();
    },
  });
  stop = () => {
    stopTicker();
    stop = null;
  };
}

export function unregisterHeldDocumentSweep(): void {
  stop?.();
}
