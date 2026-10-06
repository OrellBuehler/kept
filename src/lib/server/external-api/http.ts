import { isHttpError, json, type RequestEvent } from "@sveltejs/kit";
import { z } from "zod";
import type { ApiScope } from "$lib/api-tokens";
import type { ApiTokenAuth } from "$lib/server/auth/api-tokens";
import { LedgerError } from "$lib/server/ledger/errors";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const MAX_BODY_CHARS = 10_000;

/** An expected failure with the status and message the client gets (`{ "message": … }`). */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiContext {
  event: RequestEvent;
  token: ApiTokenAuth;
  /** The owner of the token: every query is scoped to this id. */
  userId: string;
  url: URL;
}

function errorResponse(status: number, message: string): Response {
  return json({ message }, { status });
}

/**
 * Wraps an external API handler: the hook has already authenticated the
 * request, this re-checks that a token is present (a handler never trusts
 * `locals.user`), enforces the scope, and answers every failure as
 * `{ "message": … }`. Anything unexpected is rethrown for `handleError`.
 */
export function apiEndpoint(
  scope: ApiScope | null,
  fn: (ctx: ApiContext) => Promise<unknown>,
): (event: RequestEvent) => Promise<Response> {
  return async (event) => {
    const token = event.locals.apiToken;
    if (!token) return errorResponse(401, "A bearer token is required.");
    if (scope !== null && !token.scopes.includes(scope)) {
      return errorResponse(403, `This token lacks the ${scope} permission.`);
    }
    try {
      const result = await fn({
        event,
        token,
        userId: token.userId,
        url: event.url,
      });
      return result instanceof Response ? result : json(result);
    } catch (err) {
      if (err instanceof ApiError)
        return errorResponse(err.status, err.message);
      if (err instanceof LedgerError) {
        const status =
          err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
        return errorResponse(status, err.message);
      }
      if (isHttpError(err) && err.status < 500) {
        return errorResponse(err.status, err.body.message);
      }
      throw err;
    }
  };
}

export const notFoundError = (what: string) =>
  new ApiError(404, `${what} not found.`);

function invalid(error: z.ZodError): ApiError {
  const issue = error.issues[0];
  const field = issue?.path.join(".");
  return new ApiError(
    400,
    field
      ? `Invalid ${field}: ${issue?.message}`
      : `Invalid request: ${issue?.message}`,
  );
}

/** Parses the query string; the first value of a repeated key is used, unknown keys are ignored. */
export function parseQuery<S extends z.ZodType>(
  url: URL,
  schema: S,
): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!(key in raw)) raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(parsed.error);
  }
  return parsed.data;
}

/** A JSON POST body, parsed with Zod. Bearer requests need no Origin check: no cookie authenticates them. */
export async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new ApiError(415, "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS * 4) {
    throw new ApiError(413, "Request body too large.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    throw new ApiError(413, "Request body too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new ApiError(400, "Body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(parsed.error);
  }
  return parsed.data;
}

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, "Not a real date.");
export const dateParam = dateOnly;

const limitParam = z
  .string()
  .regex(/^\d{1,4}$/, "Use a whole number.")
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(1, "Must be at least 1.")
      .max(MAX_LIMIT, `Must be at most ${MAX_LIMIT}.`),
  );

const updatedSinceParam = z.iso
  .datetime({ offset: true, message: "Use an ISO 8601 timestamp." })
  .transform((v) => new Date(v));

/** `limit`, `cursor` and `updatedSince`, shared by every list endpoint. */
export const pagingQuery = {
  limit: limitParam.optional(),
  cursor: z.string().max(512).optional(),
  updatedSince: updatedSinceParam.optional(),
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type KeyValue = string | number | null;
export type Key = readonly KeyValue[];

/** Null sorts last. */
function compareValue(a: KeyValue, b: KeyValue): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function compareKeys(a: Key, b: Key): number {
  for (let i = 0; i < a.length; i++) {
    const c = compareValue(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

export function encodeCursor(key: Key): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

/** A cursor is opaque to clients; a forged or foreign one is a 400, never a crash. */
export function decodeCursor(
  raw: string | undefined,
  length: number,
): Key | null {
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new ApiError(400, "Invalid cursor.");
  }
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every(
      (v) => v === null || typeof v === "string" || typeof v === "number",
    )
  ) {
    throw new ApiError(400, "Invalid cursor.");
  }
  return value as Key;
}

/**
 * Sorts by `key` (ascending, null last; the last key part must be unique) and
 * returns the page after `cursor`. For lists that are small by nature or have
 * to be filtered in code (bills, categories, accounts, recurring series).
 */
export function pageInMemory<T>(
  items: readonly T[],
  key: (item: T) => Key,
  opts: { keyLength: number; limit?: number; cursor?: string },
): Page<T> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sorted = items
    .map((item) => ({ item, key: key(item) }))
    .sort((a, b) => compareKeys(a.key, b.key));
  const after = decodeCursor(opts.cursor, opts.keyLength);
  const rest = after
    ? sorted.filter((s) => compareKeys(s.key, after) > 0)
    : sorted;
  const slice = rest.slice(0, limit);
  return {
    items: slice.map((s) => s.item),
    nextCursor:
      rest.length > limit ? encodeCursor(slice[slice.length - 1]!.key) : null,
  };
}

export const iso = (date: Date): string => date.toISOString();
