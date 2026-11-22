import { API_SCOPES, API_SCOPE_GROUPS, type ApiScope } from "$lib/api-tokens";

/**
 * `links:write` belongs to the REST API's companion links; the MCP server has
 * no tool for it, and OAuth tokens never reach the REST API, so a connection
 * cannot hold it.
 */
export const CONNECTION_SCOPES: readonly ApiScope[] = API_SCOPES.filter(
  (s) => s !== "links:write",
);

/** The permission groups the consent page offers. */
export const CONNECTION_SCOPE_GROUPS = API_SCOPE_GROUPS.map((group) => ({
  title: group.title,
  scopes: group.scopes.filter((s) => s !== "links:write"),
}));

const WRITE_SCOPES = new Set<ApiScope>(
  API_SCOPE_GROUPS.find((g) => g.title === "Write")?.scopes ?? [],
);

/** Whether a permission lets the holder change data (or revert changes). */
export const isWriteScope = (scope: ApiScope): boolean =>
  WRITE_SCOPES.has(scope);

/** What is ticked when a client asks for nothing: every read permission, no write permission. */
export const DEFAULT_SCOPES: readonly ApiScope[] = CONNECTION_SCOPES.filter(
  (s) => !isWriteScope(s),
);

/**
 * The permissions a client's `scope` parameter names. Names Kept does not
 * know (`offline_access`, a resource name from another server) are ignored: the
 * owner decides what is granted on the consent page, and the token response
 * says what was.
 */
export function parseScopeParam(raw: string | null | undefined): ApiScope[] {
  if (!raw) return [];
  const known = new Set<string>(CONNECTION_SCOPES);
  const out: ApiScope[] = [];
  for (const part of raw.split(/\s+/)) {
    if (known.has(part) && !out.includes(part as ApiScope)) {
      out.push(part as ApiScope);
    }
  }
  return out;
}
