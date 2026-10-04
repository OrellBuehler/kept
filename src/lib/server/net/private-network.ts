import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipv6Bytes } from "./ip";
import { eq } from "drizzle-orm";
import { getDB, users, type UserRole } from "$lib/server/db";

export type Lookup = (
  host: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = (host, options) => dnsLookup(host, options);

type Env = Record<string, string | undefined>;

/**
 * Whether outgoing requests to user-supplied URLs (webhooks, ntfy, integrations)
 * may reach private, loopback, link-local and metadata addresses.
 *
 * - `KEPT_NOTIFY_BLOCK_PRIVATE=true`: never, not even for administrators.
 * - `KEPT_ALLOW_PRIVATE_NETWORK=true`: always, for everyone.
 * - otherwise: administrators only, because a typical self-host has its document server
 *   or ntfy on the internal network, but any member could otherwise point
 *   Kept at internal services.
 */
export function privateNetworkAllowed(
  role: UserRole,
  env: Env = process.env,
): boolean {
  if (env.KEPT_NOTIFY_BLOCK_PRIVATE === "true") return false;
  if (env.KEPT_ALLOW_PRIVATE_NETWORK === "true") return true;
  return role === "admin";
}

/**
 * Same, looked up by user id; an unknown user counts as a member. Stays
 * synchronous (its callers outside the auth domain are still sync), so it
 * reads the role itself instead of going through the awaited auth lookup.
 */
export function privateNetworkAllowedForUser(
  userId: string,
  env: Env = process.env,
): boolean {
  const row = getDB()
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .get();
  return privateNetworkAllowed(row?.role ?? "member", env);
}

function isPrivateV4Bytes(a: number, b: number, c = 1): boolean {
  return (
    a === 0 ||
    (a === 192 && b === 0 && c === 0) ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Loopback, private, shared (CGNAT), link-local (incl. the cloud metadata
 * address), unique-local, multicast, reserved and unspecified addresses. IPv6 is classified from its bytes, so spelling does not matter;
 * IPv4-mapped and NAT64 (64:ff9b::/96) forms are judged by the embedded IPv4
 * address, IPv4-compatible (::/96) is always private. Unparseable input counts
 * as private.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return isPrivateV4Bytes(a, b, c);
  }
  if (family !== 6) return true;
  const b = ipv6Bytes(address);
  if (!b) return true;
  const zeros = (from: number, to: number) =>
    b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 12)) return true;
  if (zeros(0, 10) && b[10] === 255 && b[11] === 255) {
    return isPrivateV4Bytes(b[12], b[13], b[14]);
  }
  // SIIT (::ffff:0:0:0/96, IPv4-translated) is a translation mechanism, never a public host.
  if (
    zeros(0, 8) &&
    b[8] === 255 &&
    b[9] === 255 &&
    b[10] === 0 &&
    b[11] === 0
  ) {
    return true;
  }
  // Local-use NAT64 (64:ff9b:1::/48).
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b[4] === 0 &&
    b[5] === 1
  ) {
    return true;
  }
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    zeros(4, 12)
  ) {
    return isPrivateV4Bytes(b[12], b[13], b[14]);
  }
  // 6to4 (2002::/16) embeds an IPv4 address in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4Bytes(b[2], b[3], b[4]);
  return (
    b[0] === 0xff ||
    (b[0] & 0xfe) === 0xfc ||
    // fe80::/10 link-local and fec0::/10 (deprecated site-local)
    (b[0] === 0xfe && b[1] >= 0x80)
  );
}

export class PrivateNetworkError extends Error {
  constructor(readonly code: "blocked_address" | "dns") {
    super(
      code === "dns"
        ? "The host name could not be resolved."
        : "This address is on a private network, which this server does not allow for your account.",
    );
    this.name = "PrivateNetworkError";
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "");
}

/** No DNS: true for private IP literals and localhost names. Cheap early check at save time. */
export function isPrivateLiteralHost(url: string): boolean {
  const host = hostOf(url).toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

/**
 * Unless `allowPrivate`, resolves the host and rejects private destinations.
 * Call it right before each request. (A DNS answer can still change between
 * this check and the connection; this is a guard rail, not a sandbox.)
 */
export async function assertHostAllowed(
  url: string,
  options: { allowPrivate: boolean; lookup?: Lookup },
): Promise<void> {
  if (options.allowPrivate) return;
  if (isPrivateLiteralHost(url))
    throw new PrivateNetworkError("blocked_address");
  const host = hostOf(url);
  let addresses: { address: string }[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(host, { all: true });
  } catch {
    throw new PrivateNetworkError("dns");
  }
  if (
    addresses.length === 0 ||
    addresses.some((a) => isPrivateAddress(a.address))
  ) {
    throw new PrivateNetworkError("blocked_address");
  }
}
