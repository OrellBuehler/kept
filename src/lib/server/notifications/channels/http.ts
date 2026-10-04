import { ChannelError } from "../types";
import { assertAllowedUrl } from "./guard";

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const TIMEOUT_MS = 10_000;

/** POSTs a JSON body; redirects are never followed. Non-2xx and network failures become `ChannelError`s. */
export async function postJson(
  fetchFn: FetchFn,
  url: string,
  body: string,
  headers: Record<string, string>,
  allowPrivate: boolean,
): Promise<void> {
  await assertAllowedUrl(url, { allowPrivate });
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
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
