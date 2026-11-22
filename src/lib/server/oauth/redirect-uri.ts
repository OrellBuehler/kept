import { REDIRECT_URI_MAX } from "./config";

/**
 * Redirect URIs of OAuth clients (RFC 8252, OAuth 2.1).
 *
 * Allowed: `https` to any host, and `http` to a loopback host (`127.0.0.1`,
 * `[::1]`, `localhost`) for native apps that listen on a local port. Never
 * `http` to another host, and no other scheme: `javascript:`, `data:` and
 * friends would turn the redirect into script execution, and the apps people
 * actually run against a self-hosted server (command-line tools, desktop
 * editors) use loopback. No credentials and no fragment in the URI.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type RedirectUriCheck =
  { ok: true; url: URL } | { ok: false; reason: string };

export function checkRedirectUri(raw: string): RedirectUriCheck {
  if (raw.length === 0 || raw.length > REDIRECT_URI_MAX) {
    return { ok: false, reason: "is empty or too long" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) {
    return {
      ok: false,
      reason: "contains a space, backslash or control character",
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    if (err instanceof TypeError) {
      return { ok: false, reason: "is not an absolute URI" };
    }
    throw err;
  }
  if (url.hash !== "" || raw.includes("#")) {
    return { ok: false, reason: "must not contain a fragment" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "must not contain credentials" };
  }
  if (url.protocol === "https:") {
    return url.hostname === ""
      ? { ok: false, reason: "has no host" }
      : { ok: true, url };
  }
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? { ok: true, url }
      : {
          ok: false,
          reason:
            "uses http for a host that is not this device (only https, or http to localhost, 127.0.0.1 or [::1])",
        };
  }
  return { ok: false, reason: "must use https, or http on a loopback address" };
}

export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether `requested` is one of the `registered` URIs: byte for byte, except
 * that a loopback URI also matches on another port, because a native app
 * picks a free one at run time (RFC 8252 section 7.3).
 */
export function matchRedirectUri(
  registered: readonly string[],
  requested: string,
): boolean {
  if (registered.includes(requested)) return true;
  const wanted = checkRedirectUri(requested);
  if (!wanted.ok || !isLoopback(wanted.url)) return false;
  return registered.some((r) => {
    const known = checkRedirectUri(r);
    return (
      known.ok &&
      isLoopback(known.url) &&
      known.url.hostname === wanted.url.hostname &&
      known.url.pathname === wanted.url.pathname &&
      known.url.search === wanted.url.search
    );
  });
}

/** `https://host/path`: where the owner would be sent, without the query, for display. */
export function describeRedirectUri(raw: string): {
  host: string;
  loopback: boolean;
} {
  const checked = checkRedirectUri(raw);
  if (!checked.ok) return { host: "", loopback: false };
  return { host: checked.url.host, loopback: isLoopback(checked.url) };
}
