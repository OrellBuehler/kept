import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, asc, eq, lt } from "drizzle-orm";
import { first, getDB, isUniqueViolation, passkeys } from "$lib/server/db";
import { logAuthEvent } from "./events";
import { AuthError, type SessionUser } from "./types";
import { describeError } from "$lib/server/errors";

const RP_NAME = "Kept";

export interface WebauthnConfig {
  rpID: string;
  origin: string;
}

/**
 * The relying party is derived from `ORIGIN` (the public URL). Without it the
 * request URL is used, which is only right when Kept is not behind a proxy.
 */
export function webauthnConfig(
  requestUrl: URL,
  originEnv: string | undefined = process.env.ORIGIN,
): WebauthnConfig {
  const base = originEnv?.trim() ? new URL(originEnv.trim()) : requestUrl;
  return { rpID: base.hostname, origin: base.origin };
}

export interface PasskeyInfo {
  id: string;
  name: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listPasskeys(userId: string): Promise<PasskeyInfo[]> {
  return await getDB()
    .select({
      id: passkeys.id,
      name: passkeys.name,
      deviceType: passkeys.deviceType,
      backedUp: passkeys.backedUp,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(asc(passkeys.createdAt));
}

export async function renamePasskey(
  userId: string,
  passkeyId: string,
  name: string,
): Promise<void> {
  const r = await getDB()
    .update(passkeys)
    .set({ name })
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)))
    .returning({ id: passkeys.id });
  if (r.length !== 1) {
    throw new AuthError("passkey_not_found", "Passkey not found.");
  }
}

export async function deletePasskey(
  userId: string,
  passkeyId: string,
): Promise<void> {
  const r = await getDB()
    .delete(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId)))
    .returning({ id: passkeys.id });
  if (r.length !== 1) {
    throw new AuthError("passkey_not_found", "Passkey not found.");
  }
  await logAuthEvent("passkey_removed", userId);
}

function parseTransports(raw: string | null): AuthenticatorTransport[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed.filter(
          (t) => typeof t === "string",
        ) as AuthenticatorTransport[])
      : [];
  } catch (err) {
    console.error(
      "Stored passkey transports are malformed:",
      describeError(err),
    );
    return [];
  }
}

export async function beginRegistration(
  user: SessionUser,
  config: WebauthnConfig,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await getDB()
    .select({
      credentialId: passkeys.credentialId,
      transports: passkeys.transports,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id));
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: config.rpID,
    userName: user.username,
    userDisplayName: user.displayName ?? user.username,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: parseTransports(p.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });
}

/** Returns null when the attestation does not verify. */
export async function finishRegistration(
  userId: string,
  name: string,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  config: WebauthnConfig,
): Promise<PasskeyInfo | null> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    console.warn("Passkey registration rejected:", describeError(err));
    return null;
  }
  if (!verification.verified) return null;
  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const duplicate = await first(
    getDB()
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialId, credential.id))
      .limit(1),
  );
  if (duplicate) return null;

  // The look-up above is only a shortcut: two registrations of one credential can
  // both pass it, so the unique index on credential_id decides.
  let row;
  try {
    row = await first(
      getDB()
        .insert(passkeys)
        .values({
          userId,
          name,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports
            ? JSON.stringify(credential.transports)
            : null,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        })
        .returning({
          id: passkeys.id,
          name: passkeys.name,
          deviceType: passkeys.deviceType,
          backedUp: passkeys.backedUp,
          createdAt: passkeys.createdAt,
          lastUsedAt: passkeys.lastUsedAt,
        }),
    );
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  await logAuthEvent("passkey_added", userId);
  return row ?? null;
}

/**
 * `userId` restricts the ceremony to one user's credentials (second factor);
 * without it any registered passkey may be used to look up the user.
 */
export async function beginAuthentication(
  userId: string | null,
  config: WebauthnConfig,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const allow = userId
    ? await getDB()
        .select({
          credentialId: passkeys.credentialId,
          transports: passkeys.transports,
        })
        .from(passkeys)
        .where(eq(passkeys.userId, userId))
    : [];
  return generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: "required",
    allowCredentials: userId
      ? allow.map((p) => ({
          id: p.credentialId,
          transports: parseTransports(p.transports),
        }))
      : undefined,
  });
}

/** Returns the owning user id when the assertion verifies, otherwise null. */
export async function finishAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  config: WebauthnConfig,
  onlyUserId: string | null,
  now: number = Date.now(),
): Promise<string | null> {
  const db = getDB();
  const stored = await first(
    db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, response.id))
      .limit(1),
  );
  if (!stored) return null;
  if (onlyUserId && stored.userId !== onlyUserId) return null;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
        counter: stored.counter,
        transports: parseTransports(stored.transports),
      },
    });
  } catch (err) {
    console.warn("Passkey assertion rejected:", describeError(err));
    return null;
  }
  if (!verification.verified) return null;

  // Compare-and-swap on the counter: a replayed or cloned assertion (counter not
  // above what is stored, as another request may just have stored it) updates
  // nothing. Authenticators that always report 0 are fine while the stored
  // counter is 0 as well.
  const newCounter = verification.authenticationInfo.newCounter;
  const updated = await db
    .update(passkeys)
    .set({ counter: newCounter, lastUsedAt: new Date(now) })
    .where(
      and(
        eq(passkeys.id, stored.id),
        newCounter === 0
          ? eq(passkeys.counter, 0)
          : lt(passkeys.counter, newCounter),
      ),
    )
    .returning({ id: passkeys.id });
  if (updated.length === 0) {
    console.warn("Passkey assertion rejected: counter did not advance");
    return null;
  }
  return stored.userId;
}
