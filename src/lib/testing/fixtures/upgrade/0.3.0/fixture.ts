/**
 * Kept 0.3.0 -> current: the synthetic database in `seed.sql`, what the upgrade must make of it,
 * and what the upgraded server must serve. Nothing here is real data.
 */
import type {
  Cell,
  Expected,
  Row,
} from "../../../../../../scripts/upgrade/lib";

// A type-only import above: this file also runs inside the images, where lib.ts is not next to it.
const int = (n: number): Cell => `i:${n}`;

export const version = "0.3.0";
/** Published image of that release (the `v` of the git tag is dropped by the image tags). */
export const image =
  "ghcr.io/orellbuehler/kept:0.3.0@sha256:41930c8739bf012d29e9ddc4e2589e6c8c44771eb8dae41aa66d83f089fa4a08";
/** The last migration of that release, in `drizzle/sqlite/meta/_journal.json`; later ones are the upgrade. */
export const lastMigration = "0016_warm_the_santerians";
/** What the baseline database must have applied before the seed: its journal entry and file hash. */
export const baseline = {
  migrations: 17,
  lastTag: lastMigration,
  lastWhen: 1791107209889,
  lastHash: "d80801d9fb6c37f6214c915bc6ef4f66e42bd4c71c857a07df3cea2f3129faff",
};
export const firstUpgradeMigration = "0017_purple_roland_deschain";

/** 32 bytes of ASCII, base64: the key the secrets in `seed.sql` were encrypted with. Not a secret. */
export const secretKey = Buffer.from(
  "kept-upgrade-fixture-key-0000001",
).toString("base64");
export const password = "upgrade-fixture-pw";

export const sessionCookies = {
  alice: "fixture-session-token-alice",
  bob: "fixture-session-token-bob",
};

/** The fixture token the Docker test inserts into `api_tokens` after the upgrade (the table is new). */
export const apiToken = "kept_UpgradeFixtureTokenNotASecret000000000000";

const documentOne = "%PDF-1.4\n% synthetic upgrade fixture document\n%%EOF\n";
/** Files next to the database, relative to its directory. */
export const files: { path: string; content: string }[] = [
  { path: "documents/usr-alice/doc-a1", content: documentOne },
  {
    path: "documents/usr-alice/doc-a2",
    content: "synthetic integration document 1001\n",
  },
  { path: "documents/usr-bob/doc-b1", content: documentOne },
  // A preview an upload left behind in 0.3.0 (upload page opened, never confirmed).
  {
    path: "pending-imports/usr-alice/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    content: "Date;Amount;Text\n2024-01-01;-1.00;fixture\n",
  },
  {
    path: "pending-imports/usr-alice/AbCdEfGhIjKlMnOpQrStUvWxYz012345.json",
    content: JSON.stringify({
      id: "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      userId: "usr-alice",
      accountId: "acc-a-chk",
      fileName: "left-behind.csv",
      format: "csv",
      size: 41,
      sha256: "0".repeat(64),
      createdAt: 1704110400000,
    }),
  },
];

/** Transactions the 0021 migration moves from `tax_year` to `deduction_year`, with their old tax year. */
export const movedToDeductionYear: Record<string, number> = {
  "tx-a-x01": 2023,
  "tx-a-x02": 2023,
  "tx-a-x04": 2024,
  "tx-a-x15": 2023,
  "tx-a-x16": 2024,
  "tx-a-x17": 2100,
  "tx-a-x18": 2020,
  "tx-a-x21": 2023,
  "tx-a-x22": 1970,
  "tx-a-x26": 2023,
  "tx-b-y01": 2023,
};

/** Tagged with a tax year, left alone (see the descriptions in seed.sql). */
export const keptAsTaxPayment: Record<string, number> = {
  "tx-a-x03": 2024,
  "tx-a-x05": 2023,
  "tx-a-x06": 2023,
  "tx-a-x07": 2023,
  "tx-a-x09": 2023,
  "tx-a-x10": 2023,
  "tx-a-x11": 2023,
  "tx-a-x12": 2023,
  "tx-a-x13": 2023,
  "tx-a-x14": 2023,
  "tx-a-x19": 2023,
  "tx-a-x20": 2023,
  "tx-a-x23": 2024,
  "tx-a-x24": 2022,
  "tx-a-x25": 2023,
  "tx-a-x27": 2023,
  "tx-b-y02": 2023,
  "tx-b-y03": 2023,
};

/** Accounts flagged archived in 0.3.0 and the `updated_at` the 0023 migration copies into `archived_at`. */
export const archivedAccounts: Record<string, number> = {
  "acc-a-sav": 1717243200000,
  "acc-a-old": 1704110400000,
  "acc-b-sav": 1709294400000,
};

export const newTables = [
  "admin_audit_log",
  "api_tokens",
  "deduction_year_migration",
  "external_links",
  "fx_rates",
  "market_data_settings",
  "paperless_instances",
  "paperless_pending",
  "pending_imports",
  "pillar_3a_buy_in_years",
  "pillar_3a_contributions",
  "pillar_3a_years",
  "portfolio_values",
  "portfolios",
  "securities",
  "security_prices",
  "trades",
  "transfers",
];

const none = null;
const rowid = (before: Row): Cell => before.__rowid;

export const expected: Expected = {
  newTables,
  newTableRows: {
    deduction_year_migration: Object.keys(movedToDeductionYear).length,
  },
  newColumns: {
    accounts: [
      "archived_at",
      "contract_number",
      "deposit_iban",
      "fill_from_transfers",
      "free_withdrawal",
      "free_withdrawal_period",
      "notice_months",
      "trades_move_cash",
    ],
    category_rules: ["seq"],
    paperless_connections: ["instance_key"],
    tax_credits: ["seq"],
    transactions: ["deduction_year", "mirror_of_id", "seq"],
    user_preferences: ["investment_cash_liquid"],
  },
  newColumnValues(table, before): Row {
    const id = before.id?.replace(/^t:/, "") ?? "";
    switch (table) {
      case "accounts":
        return {
          archived_at:
            id in archivedAccounts ? int(archivedAccounts[id]) : none,
          contract_number: none,
          deposit_iban: none,
          fill_from_transfers: int(0),
          free_withdrawal: none,
          free_withdrawal_period: none,
          notice_months: none,
          trades_move_cash: int(0),
        };
      case "category_rules":
      case "tax_credits":
        return { seq: rowid(before) };
      case "paperless_connections":
        return { instance_key: none };
      case "transactions":
        return {
          deduction_year:
            id in movedToDeductionYear ? int(movedToDeductionYear[id]) : none,
          mirror_of_id: none,
          seq: rowid(before),
        };
      case "user_preferences":
        return { investment_cash_liquid: int(0) };
      default:
        throw new Error(`no new columns expected on ${table}`);
    }
  },
  changes: {
    transactions: Object.fromEntries(
      Object.keys(movedToDeductionYear).map((id) => [
        `t:${id}`,
        { tax_year: none },
      ]),
    ),
  },
};

/** The number of rows each 0.3.0 table holds in `seed.sql` after its DELETE statements. */
export const rowCounts: Record<string, number> = {
  accounts: 9,
  auth_challenges: 2,
  auth_events: 2,
  balance_snapshots: 4,
  bill_allocations: 2,
  bills: 6,
  budgets: 3,
  categories: 17,
  category_rules: 4,
  csv_profiles: 1,
  deduction_mappings: 8,
  documents: 3,
  forecast_account_settings: 2,
  imports: 3,
  inbox_files: 4,
  institutions: 4,
  match_dismissals: 1,
  notification_channels: 4,
  notification_settings: 2,
  notifications_sent: 2,
  paperless_connections: 1,
  paperless_dismissed: 1,
  paperless_documents: 3,
  paperless_report_uploads: 2,
  passkeys: 2,
  planned_items: 2,
  recovery_codes: 2,
  recurring_series: 3,
  sessions: 3,
  tax_credits: 6,
  tax_years: 4,
  totp_credentials: 1,
  transactions: 46,
  user_preferences: 2,
  users: 3,
};

/**
 * Tables the running server writes to when users log in and browse; every other table must not
 * change. `recurring_series` is derived from the transactions on every visit of the page: the
 * suggestion rs-a-2 has no payments behind it and is dropped then. The upgrade itself is checked
 * before anything is browsed, where every row of it is still there.
 */
export const activityTables = [
  "recurring_series",
  "sessions",
  "auth_events",
  "auth_challenges",
  "api_tokens",
  "user_preferences",
];

export interface PageCheck {
  as: "alice" | "bob";
  path: string;
  status: number;
  /** Substrings the HTML must contain. */
  includes?: string[];
}

export const pages: PageCheck[] = [
  { as: "alice", path: "/", status: 200 },
  {
    as: "alice",
    path: "/accounts",
    status: 200,
    includes: ["Main current", "Euro account", "Credit card"],
  },
  {
    as: "alice",
    path: "/bills",
    status: 200,
    includes: ["Example Utility AG"],
  },
  {
    as: "alice",
    path: "/bills/bill-a1",
    status: 200,
    includes: ["Example Utility AG", "INV-2024-001"],
  },
  { as: "alice", path: "/taxes", status: 200, includes: ["2023"] },
  {
    as: "alice",
    path: "/taxes/2023",
    status: 200,
    includes: ["moved from tax payment to deduction year"],
  },
  { as: "alice", path: "/budgets", status: 200, includes: ["Groceries"] },
  {
    as: "alice",
    path: "/recurring",
    status: 200,
    includes: ["Grocer subscription"],
  },
  {
    as: "alice",
    path: "/forecast",
    status: 200,
    includes: ["Expected refund"],
  },
  {
    as: "alice",
    path: "/settings/notifications",
    status: 200,
    includes: ["kept-upgrade-alice"],
  },
  {
    as: "alice",
    path: "/settings/paperless",
    status: 200,
    includes: ["paperless.example.invalid"],
  },
  {
    as: "alice",
    path: "/admin/users",
    status: 200,
    includes: ["bob", "carol"],
  },
  { as: "bob", path: "/accounts", status: 200, includes: ["Bob current"] },
  {
    as: "bob",
    path: "/taxes/2023",
    status: 200,
    includes: ["moved from tax payment to deduction year"],
  },
  { as: "bob", path: "/settings/notifications", status: 200 },
  { as: "bob", path: "/admin/users", status: 403 },
];

/** Binary downloads and the exact bytes they must return. */
export const downloads: {
  as: "alice" | "bob";
  path: string;
  mime: string;
  bytes: string;
}[] = [
  {
    as: "alice",
    path: "/bills/bill-a1/document",
    mime: "application/pdf",
    bytes: documentOne,
  },
  {
    as: "bob",
    path: "/bills/bill-b1/document",
    mime: "application/pdf",
    bytes: documentOne,
  },
];

/** Pages a user must not reach: another user's rows answer 404. */
export const notFound: { as: "alice" | "bob"; path: string }[] = [
  { as: "bob", path: "/bills/bill-a1" },
  { as: "bob", path: "/bills/bill-a1/document" },
  { as: "bob", path: "/accounts/acc-a-chk" },
  { as: "alice", path: "/accounts/acc-b-chk" },
];

export type Get = (path: string) => Promise<{ status: number; body: unknown }>;

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Reads the upgraded server through the external API as alice; returns what differs from the dataset. */
export async function checkExternalApi(get: Get): Promise<string[]> {
  const problems: string[] = [];
  const expect = (label: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(
        `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      );
    }
  };

  const me = await get("/api/external/v1/me");
  expect("me status", me.status, 200);
  expect("me username", (me.body as { username?: string }).username, "alice");

  const accounts = await get("/api/external/v1/accounts");
  expect("accounts status", accounts.status, 200);
  expect(
    "accounts",
    (
      accounts.body as Page<{ id: string; currency: string; archived: boolean }>
    ).items
      .map((a) => [a.id, a.currency, a.archived])
      .sort(),
    [
      ["acc-a-card", "CHF", false],
      ["acc-a-chk", "CHF", false],
      ["acc-a-eur", "EUR", false],
      ["acc-a-old", "CHF", true],
      ["acc-a-sav", "CHF", true],
      ["acc-a-usd", "USD", false],
    ],
  );

  const eur = await get(
    "/api/external/v1/transactions?accountId=acc-a-eur&limit=200",
  );
  expect("eur transactions status", eur.status, 200);
  expect(
    "eur transactions",
    (eur.body as Page<{ id: string; amount: number; currency: string }>).items
      .map((t) => [t.id, t.amount, t.currency])
      .sort(),
    [
      ["tx-a-10", -45000, "EUR"],
      ["tx-a-11", -9999, "EUR"],
      ["tx-a-12", 300000, "EUR"],
      ["tx-a-x14", -50000, "EUR"],
    ],
  );

  const usd = await get("/api/external/v1/transactions?accountId=acc-a-usd");
  expect(
    "largest safe integer",
    (usd.body as Page<{ amount: number }>).items.map((t) => t.amount),
    [Number.MAX_SAFE_INTEGER],
  );

  const bills = await get("/api/external/v1/bills");
  expect("bills status", bills.status, 200);
  expect(
    "bills",
    (
      bills.body as Page<{ id: string; status: string; paidAmount: number }>
    ).items
      .map((b) => [b.id, b.status, b.paidAmount])
      .sort(),
    [
      ["bill-a1", "paid", 25000],
      ["bill-a2", "open", 0],
      ["bill-a3", "cancelled", 0],
      ["bill-a4", "partially_paid", 5000],
      ["bill-a5", "credit_due", 0],
    ],
  );

  const categories = await get("/api/external/v1/categories");
  expect(
    "categories",
    (categories.body as Page<{ id: string }>).items.length,
    14,
  );

  const other = await get("/api/external/v1/transactions/tx-b-01");
  expect("another user's transaction", other.status, 404);
  const otherBill = await get("/api/external/v1/bills/bill-b1");
  expect("another user's bill", otherBill.status, 404);
  return problems;
}
