import {
  isActionFailure,
  isHttpError,
  isRedirect,
  type RequestEvent,
} from "@sveltejs/kit";
import { z } from "zod";

/** What a `+page.server.ts` exports, as far as the bridge needs it. */
export interface PageModule {
  load?: (event: never) => unknown;
  actions?: Record<string, (event: never) => unknown>;
}

/** What a `+server.ts` exports. */
export type EndpointModule = Partial<
  Record<"GET" | "POST", (event: never) => Response | Promise<Response>>
>;

export interface Route<M> {
  /** Path under `/pages/` or `/files/`, `[name]` marks a parameter. */
  api: string;
  /** The web route it stands for: its id for `event.route` and its path for `event.url`. */
  routeId: string;
  web: string;
  module: () => Promise<M>;
}

export interface Match<M> {
  route: Route<M>;
  params: Record<string, string>;
}

const isParam = (segment: string) =>
  segment.startsWith("[") && segment.endsWith("]");

/** Finds the route for a path; a literal segment wins over a parameter ("bills/new" before "bills/[id]"). */
export function matchRoute<M>(
  routes: readonly Route<M>[],
  path: string,
): Match<M> | null {
  const segments = path.split("/").filter((s) => s !== "");
  let best: (Match<M> & { literals: number }) | null = null;
  for (const route of routes) {
    const pattern = route.api.split("/").filter((s) => s !== "");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (isParam(pattern[i])) params[pattern[i].slice(1, -1)] = segments[i];
      else if (pattern[i] === segments[i]) literals++;
      else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || literals > best.literals)) {
      best = { route, params, literals };
    }
  }
  return best && { route: best.route, params: best.params };
}

/** Cookies of a bridged request: none come in and none go out, a handler that sets one changes nothing. */
class NoCookies {
  private jar = new Map<string, string>();
  get(name: string) {
    return this.jar.get(name);
  }
  getAll() {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  set(name: string, value: string) {
    this.jar.set(name, value);
  }
  delete(name: string) {
    this.jar.delete(name);
  }
  serialize(name: string, value: string) {
    return `${name}=${value}`;
  }
}

/** Query parameters the bridge reads itself; the page never sees them. */
const ACTION_PARAM = "_action";

function webUrl(
  event: RequestEvent,
  web: string,
  params: Record<string, string>,
): URL {
  const path = web.replace(/\[(\w+)\]/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const url = new URL(path, event.url.origin);
  for (const [key, value] of event.url.searchParams) {
    if (key !== ACTION_PARAM) url.searchParams.append(key, value);
  }
  return url;
}

function bridgedEvent<M>(
  event: RequestEvent,
  match: Match<M>,
  request: Request,
  url: URL,
) {
  return {
    locals: event.locals,
    params: match.params,
    url,
    route: { id: match.route.routeId },
    request,
    cookies: new NoCookies(),
    getClientAddress: event.getClientAddress,
    setHeaders: () => {},
    fetch: event.fetch,
    platform: event.platform,
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    tracing: event.tracing,
    parent: async () => ({}),
    depends: () => {},
    untrack: <T>(fn: () => T) => fn(),
  } as never;
}

/**
 * JSON for the apps: dates as ISO 8601 strings, a Map as an object, a Set as
 * an array, `undefined` left out. Page data is otherwise plain already.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v];
    if (typeof v === "bigint") return v.toString();
    return v;
  });
}

function respond(body: unknown, status = 200): Response {
  return new Response(toJson(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const message = (text: string, status: number) =>
  respond({ message: text }, status);

/**
 * A page may return a promise as a top-level value (SvelteKit streams those to
 * the browser); JSON has no later, so the answer waits for them.
 */
export async function settled(data: unknown): Promise<unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  const entries = await Promise.all(
    Object.entries(data).map(
      async ([key, value]) => [key, await value] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** Runs a page's `load` and answers `{ data }`, or `{ redirect }` when the page sends the browser elsewhere. */
export async function runLoad(
  event: RequestEvent,
  match: Match<PageModule>,
): Promise<Response> {
  const mod = await match.route.module();
  if (!mod.load) return respond({ data: {} });
  const url = webUrl(event, match.route.web, match.params);
  try {
    const data = await mod.load(
      bridgedEvent(event, match, new Request(url), url),
    );
    return respond({ data: await settled(data ?? {}) });
  } catch (err) {
    if (isRedirect(err)) return respond({ redirect: err.location });
    if (isHttpError(err) && err.status < 500) {
      return message(err.body.message, err.status);
    }
    throw err;
  }
}

/** With the image's `BODY_SIZE_LIMIT` (25M) the server refuses more before this is reached. */
const MAX_ACTION_BODY_CHARS = 40_000_000;

const fileSchema = z.object({
  $file: z.object({
    name: z.string().min(1).max(255),
    type: z.string().max(100).default("application/octet-stream"),
    base64: z.base64(),
  }),
});

/**
 * An action's form as JSON: every value is what the HTML form would send
 * (a string, or a list of strings for a repeated field), a file is
 * `{ "$file": { name, type, base64 } }`. `null` means "not sent".
 */
const actionBodySchema = z.record(
  z.string().max(100),
  z.union([z.string(), z.array(z.string()), fileSchema, z.null()]),
);

async function readForm(request: Request): Promise<FormData | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  const form = new FormData();
  if (request.headers.get("content-length") === "0") return form;
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return message("Content-Type must be application/json.", 415);
  }
  const text = await request.text();
  if (text.length > MAX_ACTION_BODY_CHARS) {
    return message("Request body too large.", 413);
  }
  if (text.trim() === "") return form;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return message("Body is not valid JSON.", 400);
  }
  const parsed = actionBodySchema.safeParse(raw);
  if (!parsed.success) {
    return message(
      "The body must be an object of strings, string lists and files.",
      400,
    );
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === null) continue;
    if (typeof value === "string") form.append(key, value);
    else if (Array.isArray(value)) for (const v of value) form.append(key, v);
    else {
      const file = value.$file;
      form.append(
        key,
        new File([Buffer.from(file.base64, "base64")], file.name, {
          type: file.type,
        }),
      );
    }
  }
  return form;
}

function firstError(data: unknown): string {
  const errors = (data as { errors?: Record<string, unknown> } | null)?.errors;
  if (errors && typeof errors === "object") {
    const lists = [errors.form, ...Object.values(errors)];
    for (const list of lists) {
      if (Array.isArray(list) && typeof list[0] === "string") return list[0];
    }
  }
  return "The request could not be completed.";
}

/**
 * Runs a page's form action. Answers `{ ok: true, data }` (plus `redirect`
 * when the page navigates after it), or for a refused form the action's status
 * with `{ ok: false, message, data }`, where `data.errors` is keyed by field.
 */
export async function runAction(
  event: RequestEvent,
  match: Match<PageModule>,
): Promise<Response> {
  const name = event.url.searchParams.get(ACTION_PARAM) ?? "default";
  const mod = await match.route.module();
  const action = Object.hasOwn(mod.actions ?? {}, name)
    ? mod.actions?.[name]
    : undefined;
  if (!action) return message("Unknown action.", 404);

  const form = await readForm(event.request);
  if (form instanceof Response) return form;
  const url = webUrl(event, match.route.web, match.params);
  const request = new Request(url, {
    method: "POST",
    body: form,
    headers: { origin: url.origin },
  });
  try {
    const result = await action(bridgedEvent(event, match, request, url));
    if (isActionFailure(result)) {
      return respond(
        { ok: false, message: firstError(result.data), data: result.data },
        result.status,
      );
    }
    return respond({ ok: true, data: result ?? {} });
  } catch (err) {
    if (isRedirect(err)) {
      return respond({ ok: true, data: {}, redirect: err.location });
    }
    if (isHttpError(err) && err.status < 500) {
      return message(err.body.message, err.status);
    }
    throw err;
  }
}

/** Passes a `+server.ts` handler through: documents, reports, logos and the two JSON previews. */
export async function runEndpoint(
  event: RequestEvent,
  match: Match<EndpointModule>,
  method: "GET" | "POST",
): Promise<Response> {
  const mod = await match.route.module();
  const handler = mod[method];
  if (!handler) return message("Method not allowed", 405);
  const url = webUrl(event, match.route.web, match.params);
  const headers = new Headers(event.request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  // The handlers accept JSON from their own origin only; a bearer request has none to forge.
  headers.set("origin", url.origin);
  const request = new Request(url, {
    method,
    headers,
    body: method === "POST" ? await event.request.arrayBuffer() : undefined,
  });
  try {
    return await handler(bridgedEvent(event, match, request, url));
  } catch (err) {
    if (isHttpError(err) && err.status < 500) {
      return message(err.body.message, err.status);
    }
    throw err;
  }
}
