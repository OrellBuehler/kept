import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ChannelError } from "../types";

export type Lookup = (
  host: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = (host, options) => dnsLookup(host, options);

/** Opt-in: private destinations are allowed by default (a LAN ntfy is the main use case). */
export function blockPrivateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.KEPT_NOTIFY_BLOCK_PRIVATE === "true";
}

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Loopback, RFC1918, unique-local, link-local and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);
  if (lower === "::" || lower === "::1") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

const blocked = () =>
  new ChannelError(
    "blocked_address",
    "This address is on a private network, which this server does not allow.",
  );

/**
 * When `KEPT_NOTIFY_BLOCK_PRIVATE=true`, resolves the host and rejects private
 * destinations. Runs at save and at send time. (A DNS answer can still change
 * between this check and the request; this is a guard rail, not a sandbox.)
 */
export async function assertAllowedUrl(
  url: string,
  options: {
    env?: Record<string, string | undefined>;
    lookup?: Lookup;
  } = {},
): Promise<void> {
  if (!blockPrivateEnabled(options.env)) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(host, { all: true });
  } catch {
    throw new ChannelError("dns", "The host name could not be resolved.");
  }
  if (
    addresses.length === 0 ||
    addresses.some((a) => isPrivateAddress(a.address))
  ) {
    throw blocked();
  }
}
