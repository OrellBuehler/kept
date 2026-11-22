import type { RequestEvent } from "@sveltejs/kit";
import { clientKey } from "$lib/server/auth/login";
import { LoginRateLimiter, WINDOW_MS } from "$lib/server/auth/rate-limit";
import {
  OAUTH_MAX_BODY_BYTES,
  REGISTRATIONS_PER_HOUR,
  TOKEN_FAILURES_PER_IP,
} from "./config";
import { OAuthError } from "./errors";

/**
 * CORS of the endpoints local and browser-based clients call from another
 * origin: the metadata documents, registration, token and revocation. They
 * carry no cookie and no ambient credential (a public client proves itself
 * with the single-use code and its PKCE verifier, in the body), so any origin
 * may read the answer and `Access-Control-Allow-Credentials` is never sent.
 * That is not access control: a page that can reach this server can ask for a
 * token only with a code it was given. The authorization endpoint is a browser
 * navigation with the owner's session cookie and has no CORS headers at all.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

export function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

/** A JSON answer that must not be cached (tokens, registrations) with CORS. */
export function oauthJson(body: unknown, status = 200): Response {
  return withCors(
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    }),
  );
}

/** A cacheable public metadata document with CORS. */
export function metadataJson(body: unknown): Response {
  return withCors(
    Response.json(body, {
      headers: { "cache-control": "public, max-age=300" },
    }),
  );
}

/** Failed token-endpoint calls per address; a success gives its attempt back. */
export const tokenFailureLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  TOKEN_FAILURES_PER_IP,
  TOKEN_FAILURES_PER_IP,
  Infinity,
);

/** Registrations per address and hour; never refunded. */
export const registrationLimiter = new LoginRateLimiter(
  Date.now,
  60 * 60 * 1000,
  REGISTRATIONS_PER_HOUR,
  REGISTRATIONS_PER_HOUR,
  Infinity,
);

/** Revocation calls per address; they never fail, so this only bounds the work. */
export const revocationLimiter = new LoginRateLimiter(
  Date.now,
  WINDOW_MS,
  120,
  120,
  Infinity,
);

/** Takes one attempt of the address from the limiter or throws the 429 answer. */
export function acquireOrRefuse(
  limiter: LoginRateLimiter,
  event: Pick<RequestEvent, "getClientAddress">,
): { release: () => void } {
  const ip = clientKey(event.getClientAddress);
  const attempt = limiter.acquire(ip, ip);
  if (!attempt.allowed) {
    throw new OAuthError(
      "temporarily_unavailable",
      "Too many requests, try again later.",
      429,
      {
        "retry-after": String(
          Math.max(1, Math.ceil(attempt.retryAfterMs / 1000)),
        ),
      },
    );
  }
  return { release: attempt.release };
}

/** Reads a body of at most `max` bytes as text, or throws a 413 answer. */
export async function readBodyText(
  request: Request,
  max: number = OAUTH_MAX_BODY_BYTES,
): Promise<string> {
  const tooLarge = () =>
    new OAuthError("invalid_request", "The request body is too large.", 413);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The fields of an `application/x-www-form-urlencoded` body. A repeated field
 * is refused (RFC 6749 section 3.2), except `resource`, where only the first
 * counts: the token is bound to this server's MCP endpoint whatever else is named.
 */
export async function readForm(
  request: Request,
): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new OAuthError(
      "invalid_request",
      "The content type must be application/x-www-form-urlencoded.",
    );
  }
  const params = new URLSearchParams(await readBodyText(request));
  const out: Record<string, string> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (values.length > 1 && name !== "resource") {
      throw new OAuthError("invalid_request", "A parameter is repeated.");
    }
    out[name] = values[0]!;
  }
  return out;
}
