const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Format a `YYYY-MM-DD` booking date for display. */
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(`${iso}T00:00:00Z`));
}

/** Today's date in the user's local timezone as `YYYY-MM-DD`. */
export function todayIso(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DAY_MS = 86_400_000;

/** Age of an instant in whole days. */
export function daysSince(ms: number, now = Date.now()): number {
  return Math.floor((now - ms) / DAY_MS);
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** "3 months ago", "12 days ago" — coarse, for staleness hints. */
export function formatAgo(ms: number, now = Date.now()): string {
  const days = Math.max(0, daysSince(ms, now));
  if (days < 60) return relative.format(-days, "day");
  if (days < 730) return relative.format(-Math.floor(days / 30.4), "month");
  return relative.format(-Math.floor(days / 365), "year");
}
