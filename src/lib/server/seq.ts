let last = 0;

/**
 * Insertion-order key for rows that need a stable tie-break (`seq` columns).
 * Microsecond-scale wall clock, forced strictly increasing within the process,
 * so it never repeats and stays ahead of the `rowid`-derived values that
 * existing rows were given when the columns were added. Across restarts the
 * order follows the wall clock: if it moved backwards, newer rows can sort
 * before older ones until it catches up, and `id` remains the final tie-break.
 */
export function nextSeq(): number {
  last = Math.max(Date.now() * 1000, last + 1);
  return last;
}
