import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Grant } from "$lib/server/auth/grant";
import { createMcpServer } from "./server";

/** Largest JSON-RPC body accepted; a tool call is a few hundred bytes. */
export const MCP_MAX_BODY_BYTES = 256 * 1024;

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers },
  );
}

/**
 * Serves one Streamable HTTP request in stateless mode: every POST gets its own
 * server and transport (no session map to bound or sweep; the client's
 * `initialize` and each later call are independent requests) and answers with
 * plain JSON. There is no server-initiated stream, so GET and DELETE are 405
 * as the transport specification allows.
 */
export async function handleMcpRequest(
  request: Request,
  grant: Grant,
  origin: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed.", {
      allow: "POST",
    });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) {
    return jsonRpcError(413, -32000, "Request body too large.");
  }
  const server = createMcpServer(grant, origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
