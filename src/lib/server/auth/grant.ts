import { IMPLIED_SCOPES, scopeConflicts, type ApiScope } from "$lib/api-tokens";
import type { Actor } from "$lib/server/audit/context";
import type { Visibility } from "$lib/server/ledger/visibility";

/**
 * What a credential may do, resolved once per request. Both token surfaces (the
 * external REST API and the MCP server) derive their `Grant` from the credential
 * that authenticated the request, and everything downstream (scope checks, query
 * filters, the change log's actor) reads only this. A credential kind joins by
 * producing the same object from its own record: a `CredentialKind` and a
 * `grantFrom…` function next to `grantFromApiToken`; nothing else changes.
 */
export type CredentialKind = "api_token" | "mcp_connection";

/** What a credential record contributes to its grant. */
export interface CredentialAuth {
  id: string;
  userId: string;
  /** The credential's name when it was verified: a display snapshot for the change log. */
  name: string;
  scopes: readonly ApiScope[];
  categoryIds: string[] | null;
  accountIds: string[] | null;
}

export interface Grant extends Visibility {
  /** The owner: every query is scoped to this id. */
  readonly userId: string;
  readonly credential: { readonly kind: CredentialKind; readonly id: string };
  /** A display snapshot of the credential's name, for the change log. */
  readonly name: string;
  readonly scopes: readonly ApiScope[];
}

/**
 * Scopes a credential holds, minus those that cannot honour its restrictions
 * (see `SCOPE_CONFLICTS`), plus implied ones: a credential stored with such a
 * combination still never reads past its restriction.
 */
function grantFrom(kind: CredentialKind, credential: CredentialAuth): Grant {
  const accountIds = credential.accountIds ?? null;
  const refused = new Set(
    scopeConflicts(credential.scopes, {
      categoryIds: credential.categoryIds,
      accountIds,
    }).map((c) => c.scope),
  );
  const scopes = new Set<ApiScope>();
  for (const scope of credential.scopes) {
    if (refused.has(scope)) continue;
    scopes.add(scope);
    for (const implied of IMPLIED_SCOPES[scope] ?? []) scopes.add(implied);
  }
  return {
    userId: credential.userId,
    credential: { kind, id: credential.id },
    name: credential.name,
    scopes: [...scopes],
    categoryIds: credential.categoryIds,
    accountIds,
  };
}

/** The grant of an authenticated API token. */
export const grantFromApiToken = (token: CredentialAuth): Grant =>
  grantFrom("api_token", token);

/**
 * The grant of an OAuth connection's access token. The connection id is the
 * credential id, so the change log attributes what it changed to the
 * connection, whatever access token it used.
 */
export const grantFromConnection = (connection: CredentialAuth): Grant =>
  grantFrom("mcp_connection", connection);

export const hasScope = (grant: Grant, scope: ApiScope): boolean =>
  grant.scopes.includes(scope);

export const hasScopes = (grant: Grant, scopes: readonly ApiScope[]): boolean =>
  scopes.every((s) => hasScope(grant, s));

/** The change-log actor of a request made with this grant. */
export function actorOf(grant: Grant, kind: "api" | "mcp"): Actor {
  return {
    kind,
    userId: grant.userId,
    tokenId: grant.credential.id,
    label: grant.name,
  };
}
