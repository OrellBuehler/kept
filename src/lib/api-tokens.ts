/** Shared (client-safe) constants of the token API and the MCP server. The database schema re-exports these. */
export const API_SCOPES = [
  "bills:read",
  "transactions:read",
  "recurring:read",
  "categories:read",
  "accounts:read",
  "links:write",
  "balances:read",
  "budgets:read",
  "forecast:read",
  "investments:read",
  "pillar3a:read",
  "taxes:read",
  "changes:read",
  "bills:write",
  "matches:write",
  "transactions:write",
  "categories:write",
  "changes:revert",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "bills:read": "Read bills and their status",
  "transactions:read": "Read transactions",
  "recurring:read": "Read recurring payments",
  "categories:read": "Read categories",
  "accounts:read": "Read account names and types",
  "links:write": "Add and remove links on bills and transactions",
  "balances:read": "Read account balances and net worth",
  "budgets:read": "Read budgets and spending per category",
  "forecast:read": "Read the cash-flow forecast and planned items",
  "investments:read": "Read investment holdings and their value",
  "pillar3a:read": "Read pillar 3a accounts, contributions and limits",
  "taxes:read": "Read tax years, deductions and reconciliation",
  "changes:read": "Read the change log entries this token made",
  "bills:write": "Create, edit, cancel and delete bills",
  "matches:write":
    "Match payments to bills: allocate, remove, dismiss, auto-match",
  "transactions:write": "Change the category and note of a payment",
  "categories:write": "Create, edit and delete categories and category rules",
  "changes:revert": "Revert changes this token made (also lets it read them)",
};

/** The permissions the token form groups together. */
export const API_SCOPE_GROUPS: readonly {
  title: string;
  scopes: readonly ApiScope[];
}[] = [
  {
    title: "Read",
    scopes: [
      "bills:read",
      "transactions:read",
      "recurring:read",
      "categories:read",
      "accounts:read",
      "balances:read",
      "budgets:read",
      "forecast:read",
      "investments:read",
      "pillar3a:read",
      "taxes:read",
      "changes:read",
    ],
  },
  {
    title: "Write",
    scopes: [
      "links:write",
      "bills:write",
      "matches:write",
      "transactions:write",
      "categories:write",
      "changes:revert",
    ],
  },
];

/** `changes:revert` needs to see the entries it reverts, so it brings `changes:read` along. */
export const IMPLIED_SCOPES: Partial<Record<ApiScope, readonly ApiScope[]>> = {
  "changes:revert": ["changes:read"],
};

export type RestrictionKind = "categories" | "accounts";

/**
 * Scopes whose data cannot honour a restriction: they aggregate across every
 * category or account (or write rules that apply to all of them). Such a scope
 * is refused together with that restriction when a token is created, and
 * ignored at request time if such a token exists anyway. `what` completes
 * "A token limited to <restriction> cannot ...".
 */
export const SCOPE_CONFLICTS: Partial<
  Record<ApiScope, { what: string } & Partial<Record<RestrictionKind, string>>>
> = {
  "recurring:read": {
    what: "read recurring payments",
    categories: "they are detected across all categories",
    accounts: "they are detected across all accounts",
  },
  "balances:read": {
    what: "read balances",
    categories: "balances are not split by category",
  },
  "budgets:read": {
    what: "read budgets",
    categories: "budgets roll subcategories up",
    accounts: "spending is summed across all accounts",
  },
  "forecast:read": {
    what: "read the forecast",
    categories: "it projects every bill and planned item",
    accounts: "it projects every bill and planned item",
  },
  "investments:read": {
    what: "read investments",
    categories: "holdings are not split by category",
  },
  "pillar3a:read": {
    what: "read pillar 3a",
    categories: "contribution limits count across all categories",
    accounts: "contribution limits count across all accounts",
  },
  "taxes:read": {
    what: "read taxes",
    categories: "tax years are computed across all categories",
    accounts: "tax years are computed across all accounts",
  },
  "categories:write": {
    what: "change categories and rules",
    categories: "the category tree and its rules apply to everything",
    accounts: "rules apply to payments of every account",
  },
};

export interface TokenRestrictions {
  categoryIds: readonly string[] | null;
  accountIds: readonly string[] | null;
}

/** Why each scope clashes with the restrictions, as sentences; empty when the combination is fine. */
export function scopeConflicts(
  scopes: readonly ApiScope[],
  restrictions: TokenRestrictions,
): { scope: ApiScope; message: string }[] {
  const out: { scope: ApiScope; message: string }[] = [];
  const active: [RestrictionKind, boolean][] = [
    ["categories", restrictions.categoryIds !== null],
    ["accounts", restrictions.accountIds !== null],
  ];
  for (const scope of scopes) {
    const conflict = SCOPE_CONFLICTS[scope];
    if (!conflict) continue;
    for (const [kind, on] of active) {
      const reason = conflict[kind];
      if (on && reason) {
        out.push({
          scope,
          message: `A token limited to ${kind} cannot ${conflict.what}: ${reason}.`,
        });
      }
    }
  }
  return out;
}

export const API_TOKEN_PREFIX = "kept_";

export const EXTERNAL_LINK_ENTITY_TYPES = ["bill", "transaction"] as const;
export type ExternalLinkEntityType =
  (typeof EXTERNAL_LINK_ENTITY_TYPES)[number];

export const EXTERNAL_LINK_MAX_URL = 2048;
export const EXTERNAL_LINK_MAX_LABEL = 200;
export const EXTERNAL_LINK_MAX_SOURCE = 64;
