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

export const EXTERNAL_API_PREFIX = "/api/external/v1";

/**
 * The token-authenticated external API. The check decodes the path the way the
 * router does ("/api/%65xternal/v1" reaches the same routes), so no spelling of
 * the prefix is treated as a session route.
 */
export function isExternalApiPath(pathname: string): boolean {
  return underPrefix(pathname, EXTERNAL_API_PREFIX);
}

export const APP_API_PREFIX = "/api/app/v1";

/** The API of the mobile apps: a session token as bearer token, never a cookie. Decoded like `isExternalApiPath`. */
export function isAppApiPath(pathname: string): boolean {
  return underPrefix(pathname, APP_API_PREFIX);
}

function decodePath(pathname: string): string {
  try {
    return decodeURI(pathname);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    return pathname;
  }
}

function underPrefix(pathname: string, prefix: string): boolean {
  const path = decodePath(pathname);
  return path === prefix || path.startsWith(`${prefix}/`);
}

const APP_API_PUBLIC = new Set(["/server", "/auth/login", "/auth/verify"]);

/** Paths under the app API that answer without a session: server discovery and the two sign-in steps. */
export function isPublicAppApiPath(pathname: string): boolean {
  const path = decodePath(pathname);
  return (
    path.startsWith(`${APP_API_PREFIX}/`) &&
    APP_API_PUBLIC.has(path.slice(APP_API_PREFIX.length))
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
