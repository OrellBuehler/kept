const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

/**
 * Applied to endpoints, redirects and error responses, which SvelteKit's own
 * `kit.csp` (rendered pages only) does not cover.
 */
export const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'";

const HSTS = "max-age=31536000";

/**
 * Adds the global security headers. Headers a route already set (for example
 * the PDF endpoint's own CSP, which must allow same-origin framing) win.
 */
export function applySecurityHeaders(headers: Headers, url: URL): void {
  const defaults: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Content-Security-Policy": FALLBACK_CSP,
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (url.protocol === "https:") headers.set("Strict-Transport-Security", HSTS);
}

export function withSecurityHeaders(response: Response, url: URL): Response {
  try {
    applySecurityHeaders(response.headers, url);
    return response;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    // Immutable headers (e.g. a proxied fetch response): rebuild the response.
    const copy = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
    applySecurityHeaders(copy.headers, url);
    return copy;
  }
}
