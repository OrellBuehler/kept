export function institutionInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const chars =
    words.length > 1
      ? [words[0]!, words[1]!].map((w) => Array.from(w)[0]!).join("")
      : Array.from(words[0]!).slice(0, 2).join("");
  return chars.toUpperCase();
}

export const AVATAR_CLASSES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

/** Stable theme colour class for a name. */
export function avatarClass(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_CLASSES[h % AVATAR_CLASSES.length]!;
}

export function logoUrl(id: string, version: string): string {
  return `/institutions/${encodeURIComponent(id)}/logo?v=${encodeURIComponent(version)}`;
}
