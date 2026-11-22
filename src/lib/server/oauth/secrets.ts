import { createHash, timingSafeEqual } from "node:crypto";
import { API_TOKEN_PREFIX } from "$lib/api-tokens";
import { hashToken } from "$lib/server/auth/sessions";

/**
 * Prefixes tell the gate which kind of credential a bearer string is without a
 * lookup. None of them starts with `kept_`, the prefix of an API token, so
 * the two can never be mistaken for each other.
 */
export const ACCESS_TOKEN_PREFIX = "keptat_";
export const REFRESH_TOKEN_PREFIX = "keptrt_";
export const AUTHORIZATION_CODE_PREFIX = "keptac_";

const PREFIXES = [
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  AUTHORIZATION_CODE_PREFIX,
];
if (PREFIXES.some((p) => p.startsWith(API_TOKEN_PREFIX))) {
  throw new Error("OAuth token prefixes must not start like an API token");
}

/** A secret is its prefix plus 43 base64url characters; anything much longer is not worth hashing. */
export const MAX_SECRET_LENGTH = 128;

function randomSecret(prefix: string): string {
  return (
    prefix +
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64url",
    )
  );
}

export const newAccessToken = () => randomSecret(ACCESS_TOKEN_PREFIX);
export const newRefreshToken = () => randomSecret(REFRESH_TOKEN_PREFIX);
export const newAuthorizationCode = () =>
  randomSecret(AUTHORIZATION_CODE_PREFIX);

/** Only this is stored: secrets are looked up by their SHA-256. */
export const hashSecret = hashToken;

export const isAccessToken = (value: string): boolean =>
  value.startsWith(ACCESS_TOKEN_PREFIX);

/** The shape of a PKCE code verifier (RFC 7636 section 4.1). */
export const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the base64url of a SHA-256: 43 characters. */
export const CODE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

/** Whether `verifier` hashes to the stored S256 `challenge`, compared in constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(
    createHash("sha256").update(verifier).digest("base64url"),
  );
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}
