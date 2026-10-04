import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { findUserById } from "$lib/server/auth/users";
import type { UserRole } from "$lib/server/schema";

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

/** Same, looked up by user id; an unknown user counts as a member. */
export function privateNetworkAllowedForUser(
  userId: string,
  env: Env = process.env,
): boolean {
  return privateNetworkAllowed(findUserById(userId)?.role ?? "member", env);
}

function isPrivateV4Bytes(a: number, b: number): boolean {
  return (
    a === 0 ||
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

/** The 16 bytes of an IPv6 address in any valid spelling, or null. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const v4 = tail.slice(1).map(Number);
    if (v4.some((n) => n > 255)) return null;
    const hex = (hi: number, lo: number) => (hi * 256 + lo).toString(16);
    text = `${text.slice(0, tail.index)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const fill = halves.length === 2 ? Array<string>(missing).fill("0") : [];
  const bytes: number[] = [];
  for (const g of [...head, ...fill, ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes.length === 16 ? bytes : null;
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
    const [a, b] = address.split(".").map(Number);
    return isPrivateV4Bytes(a, b);
  }
  if (family !== 6) return true;
  const b = ipv6Bytes(address);
  if (!b) return true;
  const zeros = (from: number, to: number) =>
    b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 12)) return true;
  if (zeros(0, 10) && b[10] === 255 && b[11] === 255) {
    return isPrivateV4Bytes(b[12], b[13]);
  }
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    zeros(4, 12)
  ) {
    return isPrivateV4Bytes(b[12], b[13]);
  }
  // 6to4 (2002::/16) embeds an IPv4 address in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4Bytes(b[2], b[3]);
  return (
    b[0] === 0xff ||
    (b[0] & 0xfe) === 0xfc ||
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80)
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
