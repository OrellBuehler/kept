/** Shared (client-safe) constants of the external token API. The database schema re-exports these. */
export const API_SCOPES = [
  "bills:read",
  "transactions:read",
  "recurring:read",
  "categories:read",
  "accounts:read",
  "links:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "bills:read": "Read bills and their status",
  "transactions:read": "Read transactions",
  "recurring:read": "Read recurring payments",
  "categories:read": "Read categories",
  "accounts:read": "Read account names and types",
  "links:write": "Add and remove links on bills and transactions",
};

export const API_TOKEN_PREFIX = "kept_";

export const EXTERNAL_LINK_ENTITY_TYPES = ["bill", "transaction"] as const;
export type ExternalLinkEntityType =
  (typeof EXTERNAL_LINK_ENTITY_TYPES)[number];

export const EXTERNAL_LINK_MAX_URL = 2048;
export const EXTERNAL_LINK_MAX_LABEL = 200;
export const EXTERNAL_LINK_MAX_SOURCE = 64;
