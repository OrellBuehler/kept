import { runAutoMatching, type AutoMatchResult } from "./suggestions";
import { describeError } from "$lib/server/errors";

/**
 * Runs automatic matching for a save path (bill saved, import confirmed) where a
 * matching failure must never fail the save itself. Logs only an error code.
 */
export async function autoMatchQuietly(
  userId: string,
): Promise<AutoMatchResult | null> {
  try {
    return await runAutoMatching(userId);
  } catch (err) {
    console.warn("auto-matching failed", describeError(err));
    return null;
  }
}
