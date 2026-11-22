import { API_SCOPE_GROUPS, type ApiScope } from "$lib/api-tokens";
import { publicOrigin } from "$lib/server/external-api/urls";

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const REVOKE_PATH = "/oauth/revoke";
export const MCP_RESOURCE_PATH = "/api/mcp";
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";

/**
 * Scopes a client is told about: the read permissions, the minimal set for
 * basic use (MCP asks for exactly that). A client that wants more names write
 * scopes explicitly, and the owner decides on the consent page either way.
 */
export const SCOPES_SUPPORTED: readonly ApiScope[] =
  API_SCOPE_GROUPS.find((g) => g.title === "Read")?.scopes ?? [];

/**
 * The issuer: `ORIGIN` when set, else the origin the request came in on. It is
 * also the authorization server's identifier in metadata and in the `iss`
 * parameter, so it must be the address clients use.
 */
export const issuerOf = (url: URL): string => publicOrigin(url);

/** The canonical URI of the MCP server: what tokens are issued for (RFC 8707). */
export const mcpResourceOf = (url: URL): string =>
  `${issuerOf(url)}${MCP_RESOURCE_PATH}`;

/** Where the metadata of the protected resource `/api/mcp` is (RFC 9728, path-suffixed form). */
export const resourceMetadataUrlOf = (origin: string): string =>
  `${origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_RESOURCE_PATH}`;

/** True when `value` names the MCP resource of `url`, ignoring the case of scheme and host and a trailing slash. */
export function isMcpResource(value: string, url: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  if (parsed.search !== "" || parsed.hash !== "" || value.includes("#")) {
    return false;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}` === mcpResourceOf(url);
}

export function protectedResourceMetadata(url: URL) {
  const issuer = issuerOf(url);
  return {
    resource: mcpResourceOf(url),
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES_SUPPORTED],
    bearer_methods_supported: ["header"],
    resource_name: "Kept",
  };
}

export function authorizationServerMetadata(url: URL) {
  const issuer = issuerOf(url);
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTER_PATH}`,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SCOPES_SUPPORTED],
    authorization_response_iss_parameter_supported: true,
  };
}
