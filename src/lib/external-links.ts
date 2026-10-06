/** Client-safe helpers for the links companion apps attach to bills and transactions. */
/** Control or invisible format characters (and, with `spaces`, the space too) anywhere in `value`. */
export function hasControlOrSpace(value: string, spaces = false): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (spaces && c === 0x20)) {
      return true;
    }
    // Invisible and direction-changing format characters (zero width, bidi overrides) can disguise text.
    if (/\p{Cf}/u.test(ch)) return true;
  }
  return false;
}

/**
 * An absolute http(s) URL without embedded credentials. Returns the
 * normalised form (what the browser would navigate to), or null.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const text = raw.trim();
  // The URL parser silently drops tabs and newlines, which would make two spellings one link.
  if (text === "" || hasControlOrSpace(text, true)) return null;
  // Only the plain "scheme://host" spelling: "https:///x" and "https:\\host" would be silently repaired.
  if (!/^https?:\/\/[^/\\?#@]/i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  return url.href;
}

/** Whether a stored link may be rendered as an anchor (defence in depth: rows are validated on write). */
export function isSafeLinkUrl(url: string): boolean {
  return normalizeLinkUrl(url) !== null;
}
