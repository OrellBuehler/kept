import { z } from "zod";

export const PAPERLESS_ERROR_CODES = [
  "invalid_url",
  "unauthorized",
  "forbidden",
  "not_found",
  "bad_request",
  "version",
  "redirect",
  "network",
  "tls",
  "server",
  "invalid_response",
  "wrong_type",
  "too_large",
] as const;
export type PaperlessErrorCode = (typeof PAPERLESS_ERROR_CODES)[number];

const MESSAGES: Record<PaperlessErrorCode, string> = {
  invalid_url: "Enter a valid http:// or https:// address without credentials.",
  unauthorized: "Paperless rejected the access token.",
  forbidden: "The Paperless user does not have permission for this request.",
  not_found: "Paperless could not find the requested item.",
  bad_request: "Paperless rejected the request.",
  version:
    "The Paperless API version is not supported. Kept needs Paperless-ngx 2.16 or newer.",
  redirect:
    "Paperless answered with a redirect. Check that the address uses the right scheme (https) and host.",
  network: "Paperless could not be reached (connection failed or timed out).",
  tls: "The TLS certificate of Paperless could not be verified. Fix the certificate or allow insecure TLS for this connection.",
  server: "Paperless reported a server error.",
  invalid_response: "Paperless sent a response Kept could not understand.",
  wrong_type: "Paperless sent a file of an unexpected type.",
  too_large: "The file from Paperless is too large.",
};

/** Typed failure of a Paperless call. Messages never contain response bodies or document content. */
export class PaperlessError extends Error {
  override name = "PaperlessError";
  readonly code: PaperlessErrorCode;
  readonly status?: number;

  constructor(
    code: PaperlessErrorCode,
    options: { status?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(
      options.detail ? `${MESSAGES[code]} (${options.detail})` : MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.status = options.status;
  }
}

const EXTRA_MESSAGES: Record<string, string> = {
  no_source: "Choose where Kept should look for bills first.",
  source_missing:
    "The selected tag or saved view no longer exists in Paperless. Choose another one.",
  source_unsupported:
    "The selected saved view uses filters Kept cannot apply. Choose another view or a tag.",
};

/** A user-presentable line for a stored or returned error code. */
export function messageForCode(code: string): string {
  return (
    EXTRA_MESSAGES[code] ??
    MESSAGES[code as PaperlessErrorCode] ??
    (code.startsWith("push_")
      ? `Updating Paperless failed: ${messageForCode(code.slice(5))}`
      : "An unexpected error occurred.")
  );
}

/** A user-presentable line for any error thrown by the adapter. */
export function describeError(err: unknown): string {
  if (err instanceof PaperlessError) return err.message;
  console.error("paperless: unexpected error", errorCode(err));
  return "An unexpected error occurred.";
}

/** Short machine-readable code for storage and logs. */
export function errorCode(err: unknown): string {
  if (err instanceof PaperlessError) return err.code;
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return err instanceof Error ? err.name : "unknown";
}

/**
 * http/https only, no credentials, no query or fragment, no trailing slash.
 * A path prefix (reverse proxy sub-path) is kept.
 *
 * Private, loopback and LAN addresses are allowed on purpose: Kept and Paperless
 * are self-hosted and usually sit on the same network, and every user of a Kept
 * instance is trusted by its operator. There is therefore no SSRF host filter.
 * Redirects are never followed and the token is only sent to this base URL.
 */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new PaperlessError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PaperlessError("invalid_url");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PaperlessError("invalid_url");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERTIFICATE_VERIFY_FAILED",
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
]);

export function classifyFetchError(err: unknown): PaperlessError {
  if (err instanceof PaperlessError) return err;
  const name = err instanceof Error ? err.name : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (TLS_CODES.has(code)) return new PaperlessError("tls", { cause: err });
  const message = err instanceof Error ? err.message : "";
  if (/certificate|self[- ]signed|\bssl\b|\btls\b/i.test(message)) {
    return new PaperlessError("tls", { cause: err });
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return new PaperlessError("network", {
      detail: "timed out",
      cause: err,
    });
  }
  return new PaperlessError("network", { cause: err });
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 200;
const FIRST_VERSION = 9;
const SECOND_VERSION = 10;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  allowInsecureTls?: boolean;
  /** Last negotiated API version; defaults to 9. */
  apiVersion?: number | null;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
  maxJsonBytes?: number;
}

export type Query =
  | URLSearchParams
  | Record<string, string | number | boolean>
  | Array<[string, string]>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  query?: Query;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

export interface ServerInfo {
  /** `X-Version`: the Paperless-ngx release, e.g. "2.20.3". */
  serverVersion: string | null;
  /** `X-Api-Version`: the highest API version the server speaks. */
  maxApiVersion: number | null;
}

function toSearch(query: Query | undefined): URLSearchParams {
  if (!query) return new URLSearchParams();
  if (query instanceof URLSearchParams) return new URLSearchParams(query);
  if (Array.isArray(query)) return new URLSearchParams(query);
  return new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  );
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch (err) {
    console.warn(
      "paperless: could not discard a response body",
      errorCode(err),
    );
  }
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    count: z.number().optional(),
    next: z.string().nullish(),
    results: z.array(item),
  });
}

/** One place for every call to Paperless: auth, versioning, redirects, timeouts, size limits. */
export class PaperlessClient {
  readonly baseUrl: string;
  apiVersion: number;
  serverInfo: ServerInfo = { serverVersion: null, maxApiVersion: null };
  private readonly token: string;
  private readonly allowInsecureTls: boolean;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxDownloadBytes: number;
  private readonly maxJsonBytes: number;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.allowInsecureTls = options.allowInsecureTls ?? false;
    this.apiVersion = options.apiVersion ?? FIRST_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    this.maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    this.maxJsonBytes = options.maxJsonBytes ?? MAX_JSON_BYTES;
  }

  /** `{base}/api/<path>/`, always with the trailing slash Paperless requires. */
  url(path: string, query?: Query): string {
    const clean = path.replace(/^\/+|\/+$/g, "");
    const search = toSearch(query).toString();
    return `${this.baseUrl}/api/${clean}/${search ? `?${search}` : ""}`;
  }

  /** Public URL of a document in the web UI. */
  documentUrl(paperlessId: number): string {
    return `${this.baseUrl}/documents/${paperlessId}/details`;
  }

  private async fetchOnce(
    url: string,
    init: {
      method: string;
      accept: string;
      body?: BodyInit;
      contentType?: string;
      timeoutMs: number;
    },
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Token ${this.token}`,
      Accept: init.accept,
    });
    if (init.contentType) headers.set("Content-Type", init.contentType);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs),
        // Opt-in per connection for self-signed certificates on a private network; off by default.
        ...(this.allowInsecureTls
          ? // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
            { tls: { rejectUnauthorized: false } }
          : {}),
      } as RequestInit);
    } catch (err) {
      throw classifyFetchError(err);
    }
    const serverVersion = res.headers.get("x-version");
    const maxApi = Number(res.headers.get("x-api-version"));
    if (serverVersion) this.serverInfo.serverVersion = serverVersion;
    if (Number.isInteger(maxApi) && maxApi > 0) {
      this.serverInfo.maxApiVersion = maxApi;
    }
    return res;
  }

  private async checkStatus(res: Response): Promise<Response> {
    if (res.ok) return res;
    const status = res.status;
    await discard(res);
    if (status >= 300 && status < 400) {
      throw new PaperlessError("redirect", { status });
    }
    if (status === 401) throw new PaperlessError("unauthorized", { status });
    if (status === 403) throw new PaperlessError("forbidden", { status });
    if (status === 404) throw new PaperlessError("not_found", { status });
    if (status === 406) throw new PaperlessError("version", { status });
    if (status === 400) throw new PaperlessError("bad_request", { status });
    if (status >= 500) throw new PaperlessError("server", { status });
    throw new PaperlessError("invalid_response", {
      status,
      detail: `status ${status}`,
    });
  }

  /** Sends a JSON API request; a 406 is retried once with the other API version. */
  private async send(path: string, options: RequestOptions): Promise<Response> {
    const url = this.url(path, options.query);
    const method = options.method ?? "GET";
    const body: BodyInit | undefined = options.form
      ? options.form
      : options.json === undefined
        ? undefined
        : JSON.stringify(options.json);
    const contentType =
      options.json !== undefined ? "application/json" : undefined;
    const attempt = (version: number) =>
      this.fetchOnce(url, {
        method,
        accept: `application/json; version=${version}`,
        body,
        contentType,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
      });

    let res = await attempt(this.apiVersion);
    if (res.status === 406) {
      await discard(res);
      const other =
        this.apiVersion === FIRST_VERSION ? SECOND_VERSION : FIRST_VERSION;
      res = await attempt(other);
      if (res.status !== 406) this.apiVersion = other;
    }
    return this.checkStatus(res);
  }

  async json<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<z.output<S>> {
    const res = await this.send(path, options);
    let data: unknown;
    const body = await readCapped(res, this.maxJsonBytes);
    try {
      data = JSON.parse(new TextDecoder().decode(body));
    } catch (err) {
      throw new PaperlessError("invalid_response", {
        detail: "not JSON",
        cause: err,
      });
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const at = parsed.error.issues[0]?.path.join(".") ?? "";
      throw new PaperlessError("invalid_response", {
        detail: at ? `unexpected shape at ${at}` : "unexpected shape",
      });
    }
    return parsed.data;
  }

  /**
   * Walks a paginated list. `next` URLs are never followed as given (a proxy
   * may have put the wrong host in them): only their query string is reused
   * against the configured base URL.
   */
  async *pages<S extends z.ZodType>(
    path: string,
    query: Query,
    item: S,
  ): AsyncGenerator<Array<z.output<S>>> {
    let current = toSearch(query);
    const schema = pageSchema(item);
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.json(path, schema, { query: current });
      yield page.results as Array<z.output<S>>;
      if (!page.next) return;
      let nextQuery: URLSearchParams;
      try {
        nextQuery = new URL(page.next, this.baseUrl).searchParams;
      } catch (err) {
        throw new PaperlessError("invalid_response", {
          detail: "bad next link",
          cause: err,
        });
      }
      if (nextQuery.toString() === current.toString()) {
        throw new PaperlessError("invalid_response", {
          detail: "pagination does not advance",
        });
      }
      current = nextQuery;
    }
    throw new PaperlessError("invalid_response", {
      detail: "too many pages",
    });
  }

  /** Downloads a file with a size cap and a content-type check. */
  async download(
    path: string,
    query?: Query,
    options: { expectType?: string } = {},
  ): Promise<Uint8Array> {
    const expectType = options.expectType ?? "application/pdf";
    const res = await this.checkStatus(
      await this.fetchOnce(this.url(path, query), {
        method: "GET",
        accept: "*/*",
        timeoutMs: this.downloadTimeoutMs,
      }),
    );
    const type = (res.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (type !== expectType) {
      await discard(res);
      throw new PaperlessError("wrong_type");
    }
    return readCapped(res, this.maxDownloadBytes);
  }
}

/** Reads a response body, failing with `too_large` once it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await discard(res);
    throw new PaperlessError("too_large");
  }
  if (!res.body) {
    throw new PaperlessError("invalid_response", { detail: "empty body" });
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new PaperlessError("too_large");
      }
      chunks.push(value);
    }
  } catch (err) {
    throw classifyFetchError(err);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
