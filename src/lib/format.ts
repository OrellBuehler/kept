const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Format a `YYYY-MM-DD` booking date for display. */
export function formatDate(iso: string, locale = "en-GB"): string {
  let fmt = dateFormats.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    dateFormats.set(locale, fmt);
  }
  return fmt.format(new Date(`${iso}T00:00:00Z`));
}

const monthFormats = new Map<string, Intl.DateTimeFormat>();

/** Month label for a `YYYY-MM` string, e.g. "March 2024" or just "March". */
export function formatMonth(
  month: string,
  locale = "en-GB",
  style: "long" | "short" = "long",
  withYear = true,
): string {
  const key = `${locale}|${style}|${withYear}`;
  let fmt = monthFormats.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      month: style,
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
    monthFormats.set(key, fmt);
  }
  return fmt.format(new Date(`${month}-01T00:00:00Z`));
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

/** Date and time of an instant; pass `timeZone: "UTC"` for output that is identical on server and client. */
export function formatDateTime(
  ms: number,
  timeZone?: string,
  locale = "en-GB",
): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

/** First and last day (`YYYY-MM-DD`) of the month before the one containing `now`. */
export function lastFullMonth(now = new Date()): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: iso(first), to: iso(last) };
}
