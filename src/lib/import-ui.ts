import { formatDate } from "$lib/format";
import type { ImportImpact } from "$lib/ledger-types";

export const FORMAT_LABELS = {
  camt053: "camt.053",
  csv: "CSV",
  xlsx: "Excel",
} as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPeriod(
  from: string | null,
  to: string | null,
  locale?: string,
): string {
  if (from && to) {
    return from === to
      ? formatDate(from, locale)
      : `${formatDate(from, locale)} – ${formatDate(to, locale)}`;
  }
  if (from || to) return formatDate((from ?? to)!, locale);
  return "No period";
}

export function timeAgo(ms: number, now: number, locale?: string): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDate(new Date(ms).toISOString().slice(0, 10), locale);
}

/** One line per kind of user edit that undoing an import would delete. */
export function describeImpact(impact: ImportImpact): string[] {
  const lines: [number, string][] = [
    [impact.categorized, plural(impact.categorized, "categorized transaction")],
    [impact.notes, plural(impact.notes, "note")],
    [impact.taxYears, plural(impact.taxYears, "tax year assignment")],
    [
      impact.deductionYears,
      plural(impact.deductionYears, "deduction year assignment"),
    ],
    [
      impact.billAllocations,
      `${plural(impact.billAllocations, "transaction")} matched to bills`,
    ],
    [impact.pillar3a, plural(impact.pillar3a, "pillar 3a annotation")],
    [impact.transferLinks, plural(impact.transferLinks, "transfer link")],
    [impact.mirrors, plural(impact.mirrors, "mirrored transfer row")],
  ];
  return lines.filter(([n]) => n > 0).map(([, text]) => text);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
