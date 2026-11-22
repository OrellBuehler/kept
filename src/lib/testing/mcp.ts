import { DELETE, GET, POST } from "../../routes/api/mcp/+server";
import { handle } from "../../hooks.server";
import { createTestEvent } from "./event";

export const MCP_URL = "http://localhost/api/mcp";
const PROTOCOL_VERSION = "2025-06-18";

export interface McpCall {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  ip?: string;
  /** Sent as is (a string) or serialised as JSON. */
  body?: unknown;
  path?: string;
}

/** Sends a request through the real `handle` hook and the real `/api/mcp` route handlers. */
export async function callMcp(
  token: string | null,
  call: McpCall = {},
): Promise<Response> {
  const method = call.method ?? "POST";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...call.headers,
  };
  if (token) headers.authorization ??= `Bearer ${token}`;
  const body =
    call.body === undefined
      ? undefined
      : typeof call.body === "string"
        ? call.body
        : JSON.stringify(call.body);
  const event = createTestEvent({
    url: `http://localhost${call.path ?? "/api/mcp"}`,
    method,
    headers,
    cookies: call.cookies,
    ip: call.ip,
    body,
  });
  const handler = { POST, GET, DELETE }[method as "POST" | "GET" | "DELETE"];
  const resolve = async () => {
    if (!handler) return new Response("Method Not Allowed", { status: 405 });
    return handler(event as never);
  };
  return handle({ event: event as never, resolve: resolve as never });
}

let nextId = 1;

export interface RpcResult {
  status: number;
  json: {
    jsonrpc?: string;
    id?: number | string | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

/** One JSON-RPC request; the stateless server needs no session. */
export async function rpc(
  token: string | null,
  method: string,
  params?: unknown,
  call: McpCall = {},
): Promise<RpcResult> {
  const res = await callMcp(token, {
    ...call,
    body: { jsonrpc: "2.0", id: nextId++, method, params },
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

export const initialize = (token: string | null, call: McpCall = {}) =>
  rpc(
    token,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
    { ...call, headers: { "mcp-protocol-version": "", ...call.headers } },
  );

export async function listToolNames(token: string): Promise<string[]> {
  const { json } = await rpc(token, "tools/list", {});
  return (json.result!.tools as { name: string }[]).map((t) => t.name);
}

export interface ToolOutcome {
  status: number;
  isError: boolean;
  /** `structuredContent` of a successful call; for an error the text. */
  data: Record<string, unknown>;
  text: string;
  error?: { code: number; message: string };
}

/** Calls a tool through the full request path and unpacks the result. */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const { status, json } = await rpc(token, "tools/call", {
    name,
    arguments: args,
  });
  if (json.error) {
    return {
      status,
      isError: true,
      data: {},
      text: json.error.message,
      error: json.error,
    };
  }
  const result = json.result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text: string }[];
  };
  return {
    status,
    isError: result.isError === true,
    data: result.structuredContent ?? {},
    text: result.content[0]?.text ?? "",
  };
}
