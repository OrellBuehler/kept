import { ChannelError } from "../types";
import { pinnedFetch } from "$lib/server/net/pinned-fetch";
import { assertAllowedUrl, toChannelError, type Lookup } from "./guard";

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const TIMEOUT_MS = 10_000;

/**
 * POSTs a JSON body; redirects are never followed. Non-2xx and network failures become `ChannelError`s.
 * Without an injected `fetchFn`, a destination that must stay public is resolved once and
 * connected to by the checked address (see `pinnedFetch`), so DNS rebinding cannot reach the
 * private network. An injected `fetchFn` (tests) is only preceded by a resolve-and-check.
 */
export async function postJson(
  fetchFn: FetchFn | undefined,
  url: string,
  body: string,
  headers: Record<string, string>,
  allowPrivate: boolean,
  lookup?: Lookup,
): Promise<void> {
  const pinned = fetchFn === undefined && !allowPrivate;
  if (!pinned) await assertAllowedUrl(url, { allowPrivate, lookup });
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  let res: Response;
  try {
    res = pinned
      ? await pinnedFetch(url, init, { lookup })
      : await (fetchFn ?? fetch)(url, { ...init, redirect: "manual" });
  } catch (err) {
    const mapped = toChannelError(err);
    if (mapped instanceof ChannelError) throw mapped;
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ChannelError("timeout", "The server did not answer in time.");
    }
    throw new ChannelError("network", "The server could not be reached.");
  }
  // The response body is never read, logged or shown: the channel must not be a read oracle.
  void res.body?.cancel().catch(() => undefined);
  if (res.status >= 300 && res.status < 400) {
    throw new ChannelError(
      "redirect",
      "The server answered with a redirect; use the final address.",
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ChannelError(
      "unauthorized",
      "The server rejected the credentials.",
    );
  }
  if (!res.ok) {
    throw new ChannelError(
      "http",
      `The server answered with a ${Math.floor(res.status / 100)}xx status.`,
    );
  }
}

/** http/https only, no credentials; trailing slashes removed. */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}
