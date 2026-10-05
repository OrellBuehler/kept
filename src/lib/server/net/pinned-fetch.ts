import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import {
  resolvePublicAddresses,
  type Lookup,
  type ResolvedAddress,
} from "./private-network";

export interface PinnedFetchInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  /** Skips certificate verification; for self-signed certificates on a trusted network only. */
  allowInsecureTls?: boolean;
}

const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A `fetch` for user-supplied URLs that must not reach private networks. The host is
 * resolved exactly once, every answer is checked, and the connection is made to those
 * addresses only, so a DNS server that changes its answer between check and connect
 * (DNS rebinding) gains nothing. The URL keeps its host name, so the Host header, TLS
 * server name and certificate check still use it. Redirects are never followed.
 * Throws `PrivateNetworkError` for blocked or unresolvable hosts.
 */
export async function pinnedFetch(
  url: string,
  init: PinnedFetchInit = {},
  options: { lookup?: Lookup; requester?: typeof requestPinned } = {},
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("Only http and https URLs are supported.");
  }
  const addresses = await resolvePublicAddresses(url, options);
  return (options.requester ?? requestPinned)(url, init, addresses);
}

/** Sends the request to the given addresses only, whatever the URL's host name resolves to. */
export async function requestPinned(
  url: string,
  init: PinnedFetchInit,
  addresses: ResolvedAddress[],
): Promise<Response> {
  const target = new URL(url);
  // Normalises every BodyInit (strings, FormData with its boundary, ...) into bytes and headers.
  const method = (init.method ?? "GET").toUpperCase();
  const headerBag = new Headers(init.headers);
  // No transparent decompression here, so never ask for a compressed body.
  headerBag.set("accept-encoding", "identity");
  let payload: Buffer | undefined;
  if (init.body != null) {
    const encoded = new Response(init.body);
    const blob = await encoded.blob();
    payload = Buffer.from(await blob.arrayBuffer());
    const type = encoded.headers.get("content-type") || blob.type;
    if (type && !headerBag.has("content-type")) {
      headerBag.set("content-type", type);
    }
    headerBag.set("content-length", String(payload.byteLength));
  }
  const headers: Record<string, string> = {};
  headerBag.forEach((value, key) => {
    headers[key] = value;
  });

  // A timeout or abort destroys the request or response; report the signal's reason (e.g. TimeoutError).
  const mapError = (err: unknown) =>
    init.signal?.aborted ? init.signal.reason : err;

  return new Promise<Response>((resolve, reject) => {
    const secure = target.protocol === "https:";
    const send = secure ? https.request : http.request;
    const req = send(
      {
        host: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: method,
        headers,
        agent: false,
        signal: init.signal,
        lookup: pinnedLookup(addresses),
        ...(secure && init.allowInsecureTls
          ? // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
            { rejectUnauthorized: false }
          : {}),
      } as https.RequestOptions,
      (res) => {
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        }
        const status = res.statusCode ?? 502;
        const empty = NO_BODY_STATUSES.has(status) || method === "HEAD";
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : toWebStream(res, mapError), {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on("error", (err) => reject(mapError(err)));
    req.end(payload);
  });
}

/** Pull-based web stream over a response: a slow reader applies backpressure and errors can be mapped. */
function toWebStream(
  res: IncomingMessage,
  mapError: (err: unknown) => unknown,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      res.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) res.pause();
      });
      res.on("end", () => controller.close());
      res.on("error", (err) => controller.error(mapError(err)));
      res.on("close", () => {
        if (!res.complete) {
          controller.error(mapError(new Error("The connection was closed.")));
        }
      });
      res.pause();
    },
    pull() {
      res.resume();
    },
    cancel() {
      res.destroy();
    },
  });
}

/** A `lookup` that ignores the name and answers with the already validated addresses. */
function pinnedLookup(addresses: ResolvedAddress[]) {
  return (
    _host: string,
    options: { all?: boolean; family?: number | string },
    callback: (
      err: Error | null,
      address: string | ResolvedAddress[],
      family?: number,
    ) => void,
  ) => {
    const wanted =
      options.family === 4 || options.family === "IPv4"
        ? 4
        : options.family === 6 || options.family === "IPv6"
          ? 6
          : 0;
    const usable = addresses.filter((a) => wanted === 0 || a.family === wanted);
    const list = usable.length > 0 ? usable : addresses;
    if (options.all) {
      callback(null, list);
      return;
    }
    callback(null, list[0]!.address, list[0]!.family);
  };
}
