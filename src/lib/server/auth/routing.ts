/**
 * The endpoints an OAuth client calls itself, without the owner's session:
 * registration, token and revocation, and the two metadata documents
 * (`/oauth/authorize` is not among them: it needs the owner's session).
 * They answer cross-origin requests, so they are also exempt from the
 * form-post origin check (see `isCrossOriginPath`).
 */
export const OAUTH_CLIENT_PATHS = new Set([
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
]);
const OAUTH_METADATA_PREFIXES = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
];

const PUBLIC_EXACT = new Set([
  "/login",
  "/login/verify",
  "/setup",
  "/api/health",
  ...OAUTH_CLIENT_PATHS,
]);
const PUBLIC_PREFIXES = ["/api/public/", "/api/auth/passkey/login/"];

export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_EXACT.has(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    OAUTH_METADATA_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
  );
}

/**
 * Paths that clients call from other origins with a form-encoded body or no
 * content type and no `Origin` header (a command-line client has none): the
 * only places the origin check of form posts does not apply. Nothing there
 * reads a cookie: the OAuth client endpoints take what the client presents, and
 * `/api/mcp` (matched exactly, as the SDK clients call it) takes a bearer token
 * only, so an MCP client ending its session with a bodiless `DELETE` reaches
 * the gate and gets its 405.
 */
export function isCrossOriginPath(pathname: string): boolean {
  return OAUTH_CLIENT_PATHS.has(pathname) || pathname === MCP_PATH;
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

export const MCP_PATH = "/api/mcp";

/** The MCP server: bearer API tokens only, never a cookie. Decoded like `isExternalApiPath`. */
export function isMcpPath(pathname: string): boolean {
  return underPrefix(pathname, MCP_PATH);
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
