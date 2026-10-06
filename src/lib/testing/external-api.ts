import type { ApiScope } from "$lib/api-tokens";
import { createApiToken, type ApiTokenInfo } from "$lib/server/auth/api-tokens";
import { createTestEvent } from "./event";
import { handle } from "../../hooks.server";

type Handler = (event: unknown) => Promise<Response> | Response;
type RouteModule = Record<string, Handler | undefined>;

const prefix = "/src/routes/api/external/v1";
const modules = import.meta.glob("/src/routes/api/external/v1/**/+server.ts");

interface Route {
  file: string;
  segments: string[];
}

const routes: Route[] = Object.keys(modules)
  .map((file) => ({
    file,
    segments: file
      .slice(prefix.length, -"/+server.ts".length)
      .split("/")
      .filter(Boolean),
  }))
  // static segments before [param] before [...rest]
  .sort((a, b) => score(b) - score(a));

function score(r: Route): number {
  return r.segments.reduce(
    (n, s) => n * 4 + (s.startsWith("[...") ? 0 : s.startsWith("[") ? 1 : 2),
    1,
  );
}

function match(
  path: string,
): { route: Route; params: Record<string, string> } | null {
  const parts = path
    .slice("/api/external/v1".length)
    .split("/")
    .filter(Boolean);
  for (const route of routes) {
    const params: Record<string, string> = {};
    let ok = true;
    let i = 0;
    for (const seg of route.segments) {
      if (seg.startsWith("[...")) {
        params[seg.slice(4, -1)] = parts.slice(i).join("/");
        i = parts.length;
        break;
      }
      const part = parts[i++];
      if (part === undefined) {
        ok = false;
        break;
      }
      if (seg.startsWith("["))
        params[seg.slice(1, -1)] = decodeURIComponent(part);
      else if (seg !== part) {
        ok = false;
        break;
      }
    }
    if (ok && i === parts.length) return { route, params };
  }
  return null;
}

export interface ApiCall {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  ip?: string;
}

/** Sends a request through the real `handle` hook and the real route handlers. */
export async function callApi(
  token: string | null,
  pathAndQuery: string,
  call: ApiCall = {},
): Promise<Response> {
  const url = new URL(`http://localhost${pathAndQuery}`);
  const method = call.method ?? "GET";
  const headers: Record<string, string> = { ...call.headers };
  if (token) headers.authorization ??= `Bearer ${token}`;
  if (call.body !== undefined) headers["content-type"] ??= "application/json";
  const found = match(url.pathname);
  const event = createTestEvent({
    url: url.href,
    method,
    headers,
    cookies: call.cookies,
    ip: call.ip,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    params: found?.params,
  });
  const resolve = async () => {
    if (!found) return new Response("Not Found", { status: 404 });
    const mod = (await modules[found.route.file]!()) as RouteModule;
    const handler = mod[method] ?? mod.fallback;
    if (!handler) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    return handler(event);
  };
  return handle({ event: event as never, resolve: resolve as never });
}

export async function seedToken(
  userId: string,
  scopes: readonly ApiScope[],
  over: {
    categoryIds?: string[] | null;
    expiresAt?: Date | null;
    name?: string;
  } = {},
): Promise<{ token: string; info: ApiTokenInfo }> {
  return createApiToken(userId, {
    name: over.name ?? "test token",
    scopes: [...scopes],
    categoryIds: over.categoryIds ?? null,
    expiresAt: over.expiresAt ?? null,
  });
}

/** One entry of a list response, as tests read it. */
export interface Item {
  id: string;
  name?: string;
  label?: string;
  bookingDate: string;
  dueDate?: string | null;
  categoryId?: string | null;
  parentId?: string | null;
  billIds?: string[];
  updatedAt: string;
  url?: string;
  accountId?: string;
}

/** A JSON response body, as tests read it. */
export interface Body {
  items: Item[];
  nextCursor: string | null;
  message?: string;
  id?: string;
  url?: string;
  [key: string]: unknown;
}
