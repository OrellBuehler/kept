import {
  PrivateNetworkError,
  assertHostAllowed,
  isPrivateAddress,
  type Lookup,
} from "$lib/server/net/private-network";
import { ChannelError } from "../types";

export { isPrivateAddress, type Lookup };

/** A blocked or unresolvable destination as a channel error; anything else is returned unchanged. */
export function toChannelError(err: unknown): unknown {
  if (!(err instanceof PrivateNetworkError)) return err;
  return err.code === "dns"
    ? new ChannelError("dns", "The host name could not be resolved.")
    : new ChannelError("blocked_address", err.message);
}

/**
 * Rejects private destinations unless `allowPrivate`; see `privateNetworkAllowed`
 * for who gets it. Runs at save and at send time.
 */
export async function assertAllowedUrl(
  url: string,
  options: { allowPrivate: boolean; lookup?: Lookup },
): Promise<void> {
  try {
    await assertHostAllowed(url, options);
  } catch (err) {
    throw toChannelError(err);
  }
}
