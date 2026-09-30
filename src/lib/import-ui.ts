import { formatDate } from "$lib/format";

export const FORMAT_LABELS = {
  camt053: "camt.053",
  csv: "CSV",
  xlsx: "Excel",
} as const;

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPeriod(from: string | null, to: string | null): string {
  if (from && to) {
    return from === to
      ? formatDate(from)
      : `${formatDate(from)} – ${formatDate(to)}`;
  }
  if (from || to) return formatDate((from ?? to)!);
  return "No period";
}

export function timeAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDate(new Date(ms).toISOString().slice(0, 10));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
