import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// The version prefix is authenticated, so it cannot be altered without detection.
const AAD = Buffer.from(VERSION);

// Publicly known key, used only outside production so dev and tests work
// without configuration. Never valid for real data.
const INSECURE_DEV_KEY = Buffer.alloc(KEY_BYTES, "kept-insecure-dev-key");

let warned = false;

const HELP =
  "KEPT_SECRET_KEY must be 32 random bytes encoded as base64. Generate one with: openssl rand -base64 32";

function parseKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, "base64");
  return key.length === KEY_BYTES ? key : null;
}

/**
 * The publicly known key is only usable under `vite dev`, in tests (both have
 * `import.meta.env.DEV`, which a production build folds to false), or when
 * `KEPT_ALLOW_INSECURE_KEY=true` asks for it. A built server started with
 * `bun run start` has no NODE_ENV, so that is not a safe signal on its own.
 */
function insecureKeyAllowed(): boolean {
  if (process.env.KEPT_ALLOW_INSECURE_KEY === "true") return true;
  return import.meta.env?.DEV === true;
}

function getKey(): Buffer {
  const raw = process.env.KEPT_SECRET_KEY;
  if (raw === undefined || raw.trim() === "") {
    if (!insecureKeyAllowed()) {
      throw new Error(
        `KEPT_SECRET_KEY is not set. ${HELP}. For throwaway local use only, KEPT_ALLOW_INSECURE_KEY=true opts into a publicly known key.`,
      );
    }
    if (!warned) {
      warned = true;
      console.warn(
        "KEPT_SECRET_KEY is not set: using an INSECURE development key. Never do this with real data.",
      );
    }
    return INSECURE_DEV_KEY;
  }
  const key = parseKey(raw);
  if (!key) throw new Error(`KEPT_SECRET_KEY is invalid. ${HELP}`);
  return key;
}

/**
 * A stored secret cannot be read: it was encrypted with another KEPT_SECRET_KEY,
 * is damaged, or has an unknown format. Callers show "needs re-entry" instead of failing.
 */
export class SecretUnreadableError extends Error {
  readonly code = "secret_unreadable";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretUnreadableError";
  }
}

export function assertSecretKeyConfigured(): void {
  getKey();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(AAD);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const malformed = () =>
    new SecretUnreadableError(
      "Cannot decrypt secret: unsupported or malformed format",
    );
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw malformed();
  const iv = Buffer.from(parts[1], "base64url");
  const body = Buffer.from(parts[2], "base64url");
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw malformed();
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(AAD);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new SecretUnreadableError(
      "Cannot decrypt secret: data was tampered with or KEPT_SECRET_KEY is wrong",
      { cause },
    );
  }
}

/** Test hook: re-arm the one-time dev-key warning. */
export function resetCryptoWarningForTests(): void {
  warned = false;
}
