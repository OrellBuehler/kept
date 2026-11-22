import type { RequestEvent } from "@sveltejs/kit";
import { publicOrigin } from "$lib/server/external-api/urls";
import { mcpChallenge } from "$lib/server/mcp/gate";
import { handleMcpRequest } from "$lib/server/mcp/handler";

/**
 * The MCP server (Streamable HTTP, stateless). The hook has authenticated the
 * bearer credential (an API token or an OAuth access token) and put its grant
 * in `locals`; a handler never trusts anything else.
 */
async function serve({ locals, request, url }: RequestEvent) {
  const grant = locals.grant;
  if (!grant) {
    return Response.json(
      { message: "A bearer token is required." },
      {
        status: 401,
        headers: { "www-authenticate": mcpChallenge(publicOrigin(url)) },
      },
    );
  }
  return await handleMcpRequest(request, grant, publicOrigin(url));
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
