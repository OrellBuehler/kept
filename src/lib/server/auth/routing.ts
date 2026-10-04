const PUBLIC_EXACT = new Set([
  "/login",
  "/login/verify",
  "/setup",
  "/api/health",
]);
const PUBLIC_PREFIXES = ["/api/public/", "/api/auth/passkey/login/"];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_EXACT.has(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  );
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Only same-origin relative paths are allowed ("/foo?bar=1"). Anything else
 * (absolute URLs, protocol-relative "//host", backslash tricks, control
 * characters) falls back to "/".
 */
export function safeRedirectTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  try {
    const parsed = new URL(value, "http://kept.invalid");
    if (parsed.origin !== "http://kept.invalid") return "/";
  } catch {
    return "/";
  }
  return value;
}
