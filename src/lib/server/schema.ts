import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  ACCOUNT_TYPES,
  IMPORT_FORMATS,
  REFERENCE_TYPES,
  ROW_SOURCES,
} from "$lib/ledger-types";
import {
  ALLOCATION_ORIGINS,
  BILL_KINDS,
  BILL_REFERENCE_TYPES,
  DOCUMENT_SOURCES,
} from "$lib/bill-types";
import {
  PRICE_SOURCES,
  SECURITY_KINDS,
  TRADE_SIDES,
} from "$lib/investment-types";
import {
  PILLAR_3A_CONTRIBUTION_KINDS,
  PILLAR_3A_DEDUCTIONS,
  PORTFOLIO_CLOSE_REASONS,
} from "$lib/pillar-3a-types";
import { AMOUNT_SIGNS, CATEGORY_KINDS } from "$lib/category-types";
import { DEDUCTION_TYPES } from "$lib/tax-deductions";
import { CHANNEL_KINDS } from "$lib/notification-types";
import { CADENCES, SERIES_STATUSES } from "$lib/recurring-types";
import type { Minor } from "$lib/money";
import type { Fixed8 } from "$lib/quantity";
import { IBAN_DISPLAY, LOCALES } from "$lib/preferences";

export { ACCOUNT_TYPES, IMPORT_FORMATS, REFERENCE_TYPES, ROW_SOURCES };
export type { AccountType, ImportFormat, RowSource } from "$lib/ledger-types";
export { PRICE_SOURCES, SECURITY_KINDS, TRADE_SIDES };
export type {
  PriceSource,
  SecurityKind,
  TradeSide,
} from "$lib/investment-types";
export {
  PILLAR_3A_CONTRIBUTION_KINDS,
  PILLAR_3A_DEDUCTIONS,
  PORTFOLIO_CLOSE_REASONS,
};
export type {
  Pillar3aContributionKind,
  Pillar3aDeduction,
  PortfolioCloseReason,
} from "$lib/pillar-3a-types";
export {
  ALLOCATION_ORIGINS,
  BILL_KINDS,
  BILL_REFERENCE_TYPES,
  DOCUMENT_SOURCES,
};

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
    .$onUpdate(() => new Date()),
};

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull().default("member"),
  ...timestamps,
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Last step-up authentication (password [+ code]); gates sensitive changes such as passkeys. */
    reauthAt: integer("reauth_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const totpCredentials = sqliteTable("totp_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-GCM encrypted base32 secret (see crypto.ts). */
  secret: text("secret").notNull(),
  /** Null until the user confirmed a code; unconfirmed rows do not protect the login. */
  confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
  /** Highest accepted time step; codes at or below it are rejected (replay protection). */
  lastStep: integer("last_step").notNull().default(0),
  ...timestamps,
});

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    index("recovery_codes_user_id_idx").on(t.userId),
    uniqueIndex("recovery_codes_hash_uq").on(t.userId, t.codeHash),
  ],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    credentialId: text("credential_id").notNull().unique(),
    /** base64url COSE public key. */
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    /** JSON array of AuthenticatorTransport values. */
    transports: text("transports"),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [index("passkeys_user_id_idx").on(t.userId)],
);

export const AUTH_CHALLENGE_KINDS = [
  "login",
  "passkey_register",
  "passkey_login",
  "passkey_stepup",
] as const;
export type AuthChallengeKind = (typeof AUTH_CHALLENGE_KINDS)[number];

/**
 * Short-lived server state of a half-finished authentication: the pending
 * second-factor login ("login", keyed by the hash of a cookie token) and
 * WebAuthn challenges. Never grants access on its own.
 */
export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", { enum: AUTH_CHALLENGE_KINDS }).notNull(),
    challenge: text("challenge"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (t) => [index("auth_challenges_user_id_idx").on(t.userId)],
);

export const AUTH_EVENT_TYPES = [
  "totp_enabled",
  "totp_disabled",
  "recovery_codes_regenerated",
  "recovery_code_used",
  "passkey_added",
  "passkey_removed",
  "two_factor_reset",
] as const;
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

/** Audit trail of security-relevant changes. Never stores secrets, codes or credentials. */
export const authEvents = sqliteTable(
  "auth_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    actorId: text("actor_id").notNull(),
    type: text("type", { enum: AUTH_EVENT_TYPES }).notNull(),
    ...timestamps,
  },
  (t) => [index("auth_events_user_id_idx").on(t.userId)],
);

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

const minor = (name: string) => integer(name).$type<Minor>();

/** Integer scaled by 1e8 (see quantity.ts). */
const fixed = (name: string) => integer(name).$type<Fixed8>();

export const institutions = sqliteTable(
  "institutions",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    bic: text("bic"),
    color: text("color"),
    logo: blob("logo", { mode: "buffer" }),
    logoMime: text("logo_mime"),
    logoVersion: text("logo_version"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("institutions_user_name_uq").on(t.userId, t.name),
    index("institutions_user_id_idx").on(t.userId),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    userId: userId(),
    institutionId: text("institution_id").references(() => institutions.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    currency: text("currency").notNull(),
    iban: text("iban"),
    openingBalance: minor("opening_balance")
      .notNull()
      .default(0 as Minor),
    openingDate: text("opening_date"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    /** The user's ownership share in basis points (10000 = 100%). Never applied to stored amounts. */
    shareBps: integer("share_bps").notNull().default(10000),
    /** Free-text note on who the account is shared with. */
    sharedWith: text("shared_with"),
    /** Provider contract number of a pillar 3a account (free text). */
    contractNumber: text("contract_number"),
    /** IBAN to pay into when the account itself has none (a pillar 3a QR-IBAN); not unique, providers share it. */
    depositIban: text("deposit_iban"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("accounts_user_iban_uq").on(t.userId, t.iban),
    index("accounts_user_id_idx").on(t.userId),
    index("accounts_institution_id_idx").on(t.institutionId),
  ],
);

export const imports = sqliteTable(
  "imports",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    format: text("format", { enum: IMPORT_FORMATS }).notNull(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    statementFrom: text("statement_from"),
    statementTo: text("statement_to"),
    openingBalance: minor("opening_balance"),
    openingBalanceDate: text("opening_balance_date"),
    closingBalance: minor("closing_balance"),
    closingBalanceDate: text("closing_balance_date"),
    newCount: integer("new_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    /** JSON array of strings. */
    warnings: text("warnings").notNull().default("[]"),
    ...timestamps,
  },
  (t) => [
    index("imports_user_id_idx").on(t.userId),
    index("imports_account_id_idx").on(t.accountId),
  ],
);

export const INBOX_STATUSES = [
  "imported",
  "review",
  "failed",
  "duplicate",
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const inboxFiles = sqliteTable(
  "inbox_files",
  {
    id: id(),
    userId: userId(),
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: INBOX_STATUSES }).notNull(),
    /** Why a file needs review or failed; never contains transaction data. */
    reason: text("reason"),
    accountId: text("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    importId: text("import_id").references(() => imports.id, {
      onDelete: "set null",
    }),
    newCount: integer("new_count"),
    duplicateCount: integer("duplicate_count"),
    /** File name inside the user's review/ folder while the file awaits review. */
    reviewFile: text("review_file"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("inbox_files_user_sha_uq").on(t.userId, t.sha256),
    index("inbox_files_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: id(),
    userId: userId(),
    /** One level only: a parent never has a parent of its own. */
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => categories.id,
      {
        onDelete: "set null",
      },
    ),
    name: text("name").notNull(),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull().default("expense"),
    /** `#rrggbb`. */
    color: text("color"),
    icon: text("icon"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("categories_user_name_uq").on(t.userId, t.name),
    index("categories_user_id_idx").on(t.userId),
    index("categories_parent_id_idx").on(t.parentId),
  ],
);

/**
 * Every set condition must match (AND); at least one is set. Rules run in
 * ascending `priority`, then creation order, and the first match wins.
 */
export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: id(),
    userId: userId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(100),
    counterpartyContains: text("counterparty_contains"),
    descriptionContains: text("description_contains"),
    counterpartyIban: text("counterparty_iban"),
    amountSign: text("amount_sign", { enum: AMOUNT_SIGNS }),
    ...timestamps,
  },
  (t) => [
    index("category_rules_user_id_idx").on(t.userId),
    index("category_rules_category_id_idx").on(t.categoryId),
  ],
);

/** Monthly budget for a category in one currency; no conversion between currencies. */
export const budgets = sqliteTable(
  "budgets",
  {
    id: id(),
    userId: userId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    /** Minor units, > 0. */
    amount: minor("amount").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("budgets_user_category_currency_uq").on(
      t.userId,
      t.categoryId,
      t.currency,
    ),
    index("budgets_user_id_idx").on(t.userId),
    index("budgets_category_id_idx").on(t.categoryId),
  ],
);

/** Maps one of the user's categories to a code-defined deduction type; subcategories inherit it. */
export const deductionMappings = sqliteTable(
  "deduction_mappings",
  {
    id: id(),
    userId: userId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    deductionType: text("deduction_type", { enum: DEDUCTION_TYPES }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("deduction_mappings_user_category_uq").on(
      t.userId,
      t.categoryId,
    ),
    index("deduction_mappings_category_id_idx").on(t.categoryId),
  ],
);

/**
 * A recurring payment (subscription, rent, salary ...) found in the
 * transactions. Detection refreshes the statistics; the status and any edited
 * fields are the user's decision and survive re-detection.
 */
export const recurringSeries = sqliteTable(
  "recurring_series",
  {
    id: id(),
    userId: userId(),
    /** Detection identity: counterparty (IBAN or name), currency and direction. */
    key: text("key").notNull(),
    status: text("status", { enum: SERIES_STATUSES })
      .notNull()
      .default("suggested"),
    /** Name, cadence or amount was edited by hand; detection no longer overwrites them. */
    edited: integer("edited", { mode: "boolean" }).notNull().default(false),
    name: text("name").notNull(),
    counterpartyIban: text("counterparty_iban"),
    cadence: text("cadence", { enum: CADENCES }).notNull(),
    currency: text("currency").notNull(),
    /** Signed typical amount: negative for payments, positive for income. */
    amount: minor("amount").notNull(),
    firstDate: text("first_date").notNull(),
    lastDate: text("last_date").notNull(),
    lastAmount: minor("last_amount").notNull(),
    previousAmount: minor("previous_amount"),
    occurrences: integer("occurrences").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_series_user_key_uq").on(t.userId, t.key),
    index("recurring_series_user_id_idx").on(t.userId),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    importId: text("import_id").references(() => imports.id, {
      onDelete: "cascade",
    }),
    source: text("source", { enum: ROW_SOURCES }).notNull(),
    /** Dedupe key per account; manual rows use `manual:<uuid>`. */
    externalId: text("external_id").notNull(),
    bookingDate: text("booking_date").notNull(),
    valueDate: text("value_date"),
    amount: minor("amount").notNull(),
    currency: text("currency").notNull(),
    originalAmount: minor("original_amount"),
    originalCurrency: text("original_currency"),
    counterpartyName: text("counterparty_name"),
    counterpartyIban: text("counterparty_iban"),
    description: text("description"),
    reference: text("reference"),
    referenceType: text("reference_type", { enum: REFERENCE_TYPES }),
    reversal: integer("reversal", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    /** Set by a rule on import or by hand; a manual choice is never overwritten. */
    categoryId: text("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    /** Counts as a payment to the tax office for this tax year. */
    taxYear: integer("tax_year"),
    /** Tax year this transaction is deducted in, when not its booking year. Not a tax payment. */
    deductionYear: integer("deduction_year"),
    /** Left out of the tax deductions summary. */
    deductionExcluded: integer("deduction_excluded", { mode: "boolean" })
      .notNull()
      .default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("transactions_account_external_uq").on(
      t.accountId,
      t.externalId,
    ),
    index("transactions_user_tax_year_idx").on(t.userId, t.taxYear),
    index("transactions_account_booking_idx").on(t.accountId, t.bookingDate),
    index("transactions_user_id_idx").on(t.userId),
    index("transactions_import_id_idx").on(t.importId),
    index("transactions_category_id_idx").on(t.categoryId),
  ],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    importId: text("import_id").references(() => imports.id, {
      onDelete: "cascade",
    }),
    source: text("source", { enum: ROW_SOURCES }).notNull(),
    /** End-of-day balance on this date. */
    date: text("date").notNull(),
    amount: minor("amount").notNull(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("balance_snapshots_account_date_source_uq").on(
      t.accountId,
      t.date,
      t.source,
    ),
    index("balance_snapshots_user_id_idx").on(t.userId),
    index("balance_snapshots_import_id_idx").on(t.importId),
  ],
);

export const csvProfiles = sqliteTable(
  "csv_profiles",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** JSON text, validated by the csv importer's parseMappingProfile. */
    profile: text("profile").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("csv_profiles_account_uq").on(t.accountId),
    index("csv_profiles_user_id_idx").on(t.userId),
  ],
);
export const documents = sqliteTable(
  "documents",
  {
    id: id(),
    userId: userId(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    /** Relative to the documents root; built from ids, never from user input. */
    storageKey: text("storage_key").notNull(),
    source: text("source", { enum: DOCUMENT_SOURCES }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("documents_user_sha256_uq").on(t.userId, t.sha256),
    index("documents_user_id_idx").on(t.userId),
  ],
);

export const bills = sqliteTable(
  "bills",
  {
    id: id(),
    userId: userId(),
    kind: text("kind", { enum: BILL_KINDS }).notNull().default("invoice"),
    creditorName: text("creditor_name"),
    creditorIban: text("creditor_iban"),
    /** Minor units, > 0 when set; null is an open-amount bill. */
    amount: minor("amount"),
    currency: text("currency").notNull(),
    issueDate: text("issue_date"),
    dueDate: text("due_date"),
    reference: text("reference"),
    referenceType: text("reference_type", { enum: BILL_REFERENCE_TYPES }),
    message: text("message"),
    invoiceNumber: text("invoice_number"),
    cancelled: integer("cancelled", { mode: "boolean" })
      .notNull()
      .default(false),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    expectedAccountId: text("expected_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    /** Payments allocated to this bill count as tax paid for this year. */
    taxYear: integer("tax_year"),
    /** Set by an integration adapter; the core does not interpret these. */
    externalSource: text("external_source"),
    externalRef: text("external_ref"),
    externalUrl: text("external_url"),
    /** JSON text: `{ source, warnings }` of the last extraction. */
    extraction: text("extraction"),
    ...timestamps,
  },
  (t) => [
    index("bills_user_id_idx").on(t.userId),
    index("bills_user_tax_year_idx").on(t.userId, t.taxYear),
    index("bills_user_due_idx").on(t.userId, t.dueDate),
    index("bills_document_id_idx").on(t.documentId),
    index("bills_expected_account_id_idx").on(t.expectedAccountId),
    uniqueIndex("bills_user_external_uq").on(
      t.userId,
      t.externalSource,
      t.externalRef,
    ),
  ],
);

export const taxYears = sqliteTable(
  "tax_years",
  {
    id: id(),
    userId: userId(),
    year: integer("year").notNull(),
    /** Free text; no tax office is known to the code. */
    authority: text("authority"),
    currency: text("currency").notNull(),
    /** Minor units, >= 0; the total the assessment says is owed for the year. */
    assessedTotal: minor("assessed_total"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("tax_years_user_year_uq").on(t.userId, t.year)],
);

/** A line from the tax office's account statement: what they counted as received. */
export const taxCredits = sqliteTable(
  "tax_credits",
  {
    id: id(),
    userId: userId(),
    taxYearId: text("tax_year_id")
      .notNull()
      .references(() => taxYears.id, { onDelete: "cascade" }),
    bookingDate: text("booking_date").notNull(),
    /** Signed: positive is a payment they counted, negative a repayment to you. */
    amount: minor("amount").notNull(),
    reference: text("reference"),
    description: text("description"),
    ...timestamps,
  },
  (t) => [
    index("tax_credits_user_id_idx").on(t.userId),
    index("tax_credits_tax_year_id_idx").on(t.taxYearId),
  ],
);

export const billAllocations = sqliteTable(
  "bill_allocations",
  {
    id: id(),
    userId: userId(),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    /** Signed in the bill's direction: positive settles the bill. */
    amount: minor("amount").notNull(),
    origin: text("origin", { enum: ALLOCATION_ORIGINS }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bill_allocations_pair_uq").on(t.billId, t.transactionId),
    index("bill_allocations_user_id_idx").on(t.userId),
    index("bill_allocations_transaction_id_idx").on(t.transactionId),
  ],
);

export const matchDismissals = sqliteTable(
  "match_dismissals",
  {
    id: id(),
    userId: userId(),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("match_dismissals_pair_uq").on(t.billId, t.transactionId),
    index("match_dismissals_user_id_idx").on(t.userId),
    index("match_dismissals_transaction_id_idx").on(t.transactionId),
  ],
);

/** Where an integration looks for bills: a tag or a saved view. */
export interface PaperlessBillSource {
  kind: "tag" | "saved_view";
  id: number;
  label: string;
}

/** Kept field -> Paperless custom field id; `statusValues` maps a Kept status to the value written. */
export interface PaperlessFieldMapping {
  amount?: number | null;
  dueDate?: number | null;
  reference?: number | null;
  status?: number | null;
  statusValues?: Partial<Record<string, string>>;
}

export const PAPERLESS_DOCUMENT_STATUSES = [
  "imported",
  "skipped",
  "failed",
] as const;
export const PAPERLESS_UPLOAD_STATUSES = [
  "pending",
  "success",
  "failed",
] as const;

export const paperlessConnections = sqliteTable(
  "paperless_connections",
  {
    id: id(),
    userId: userId(),
    baseUrl: text("base_url").notNull(),
    /** Encrypted with `encryptSecret`; never returned to the client. */
    tokenEncrypted: text("token_encrypted").notNull(),
    apiVersion: integer("api_version"),
    serverVersion: text("server_version"),
    billSource: text("bill_source", {
      mode: "json",
    }).$type<PaperlessBillSource>(),
    fieldMapping: text("field_mapping", {
      mode: "json",
    }).$type<PaperlessFieldMapping>(),
    /** SHA-256 (hex) of the webhook secret; the secret itself is shown once. */
    webhookSecretHash: text("webhook_secret_hash").notNull(),
    /** Random, used in the webhook URL path to identify the connection. */
    webhookToken: text("webhook_token").notNull(),
    allowInsecureTls: integer("allow_insecure_tls", { mode: "boolean" })
      .notNull()
      .default(false),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    /** Highest Paperless `modified` handled, epoch ms. */
    lastSyncModified: integer("last_sync_modified"),
    /** Short machine-readable reason, never document content. */
    lastError: text("last_error"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("paperless_connections_user_uq").on(t.userId),
    uniqueIndex("paperless_connections_token_uq").on(t.webhookToken),
  ],
);

export const paperlessDocuments = sqliteTable(
  "paperless_documents",
  {
    id: id(),
    userId: userId(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => paperlessConnections.id, { onDelete: "cascade" }),
    paperlessId: integer("paperless_id").notNull(),
    billId: text("bill_id").references(() => bills.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    /** Paperless `modified` at the last handling, epoch ms. */
    modified: integer("modified").notNull(),
    status: text("status", { enum: PAPERLESS_DOCUMENT_STATUSES }).notNull(),
    error: text("error"),
    contentSha256: text("content_sha256"),
    lastPushedHash: text("last_pushed_hash"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("paperless_documents_conn_doc_uq").on(
      t.connectionId,
      t.paperlessId,
    ),
    index("paperless_documents_user_id_idx").on(t.userId),
    index("paperless_documents_bill_id_idx").on(t.billId),
  ],
);

/** Paperless documents whose bill the user deleted; outlives the connection and its links. */
export const paperlessDismissed = sqliteTable(
  "paperless_dismissed",
  {
    id: id(),
    userId: userId(),
    /** `externalRef(baseUrl, paperlessId)`, as stored on bills. */
    externalRef: text("external_ref").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("paperless_dismissed_user_ref_uq").on(t.userId, t.externalRef),
  ],
);

export const paperlessReportUploads = sqliteTable(
  "paperless_report_uploads",
  {
    id: id(),
    userId: userId(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => paperlessConnections.id, { onDelete: "cascade" }),
    reportKind: text("report_kind").notNull(),
    sha256: text("sha256").notNull(),
    paperlessDocumentId: integer("paperless_document_id"),
    taskId: text("task_id"),
    status: text("status", { enum: PAPERLESS_UPLOAD_STATUSES }).notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("paperless_report_uploads_conn_sha_uq").on(
      t.connectionId,
      t.sha256,
    ),
    index("paperless_report_uploads_user_id_idx").on(t.userId),
  ],
);

/** Which notification triggers a user has switched on, with their parameters. */
export const notificationSettings = sqliteTable("notification_settings", {
  id: id(),
  userId: userId().unique(),
  billDueEnabled: integer("bill_due_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  billDueDays: integer("bill_due_days").notNull().default(3),
  billOverdueEnabled: integer("bill_overdue_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  budgetEnabled: integer("budget_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Notify once spending reaches this share of a monthly budget. */
  budgetPercent: integer("budget_percent").notNull().default(100),
  staleImportEnabled: integer("stale_import_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  staleImportDays: integer("stale_import_days").notNull().default(14),
  ...timestamps,
});

/** One delivery channel per kind and user. */
export const notificationChannels = sqliteTable(
  "notification_channels",
  {
    id: id(),
    userId: userId(),
    kind: text("kind", { enum: CHANNEL_KINDS }).notNull(),
    /** JSON, encrypted with `encryptSecret`; never returned to the client. */
    configEncrypted: text("config_encrypted").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    /** Short reason, never message content. */
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("notification_channels_user_kind_uq").on(t.userId, t.kind),
  ],
);

/** Events already notified, so each one is sent once. */
export const notificationsSent = sqliteTable(
  "notifications_sent",
  {
    id: id(),
    userId: userId(),
    /** e.g. `bill-overdue:<billId>:<dueDate>`. */
    eventKey: text("event_key").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("notifications_sent_user_key_uq").on(t.userId, t.eventKey),
  ],
);

/** One-off expected income or expense used by the cash-flow forecast. */
export const plannedItems = sqliteTable(
  "planned_items",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    date: text("date").notNull(),
    /** Signed minor units: positive is income, negative is an expense; never 0. */
    amount: minor("amount").notNull(),
    currency: text("currency").notNull(),
    label: text("label").notNull(),
    ...timestamps,
  },
  (t) => [
    index("planned_items_user_date_idx").on(t.userId, t.date),
    index("planned_items_account_id_idx").on(t.accountId),
  ],
);

/** Per-account forecast preferences: low-balance threshold and default payment account. */
export const forecastAccountSettings = sqliteTable(
  "forecast_account_settings",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Warn when the projected balance falls below this (minor units); null means 0. */
    threshold: minor("threshold"),
    /** Bills without a paying account are projected on this account (one per currency). */
    isDefaultPayment: integer("is_default_payment", { mode: "boolean" })
      .notNull()
      .default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("forecast_account_settings_account_uq").on(t.accountId),
    index("forecast_account_settings_user_id_idx").on(t.userId),
  ],
);

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    id: id(),
    userId: userId(),
    ibanDisplay: text("iban_display", { enum: IBAN_DISPLAY }).notNull(),
    blurAmounts: integer("blur_amounts", { mode: "boolean" }).notNull(),
    locale: text("locale", { enum: LOCALES }).notNull(),
    defaultCurrency: text("default_currency").notNull(),
    pageSize: integer("page_size").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("user_preferences_user_id_uq").on(t.userId)],
);

export const securities = sqliteTable(
  "securities",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    kind: text("kind", { enum: SECURITY_KINDS }).notNull(),
    isin: text("isin"),
    /** Provider symbol such as "VWRL.SW"; null means manual prices only. */
    symbol: text("symbol"),
    /** Currency the security is priced in. */
    currency: text("currency").notNull(),
    ...timestamps,
  },
  (t) => [index("securities_user_id_idx").on(t.userId)],
);

export const trades = sqliteTable(
  "trades",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    securityId: text("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    side: text("side", { enum: TRADE_SIDES }).notNull(),
    quantity: fixed("quantity").notNull(),
    /** Per unit, in the security's currency. */
    price: fixed("price").notNull(),
    /** Account currency. */
    fees: minor("fees")
      .notNull()
      .default(0 as Minor),
    /** Account currency, positive: cash paid or received including fees. Drives the cost basis. */
    amount: minor("amount").notNull(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("trades_user_id_idx").on(t.userId),
    index("trades_account_security_date_idx").on(
      t.accountId,
      t.securityId,
      t.date,
    ),
    index("trades_security_id_idx").on(t.securityId),
  ],
);

export const securityPrices = sqliteTable(
  "security_prices",
  {
    id: id(),
    userId: userId(),
    securityId: text("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    /** Per unit, in the security's currency. */
    price: fixed("price").notNull(),
    source: text("source", { enum: PRICE_SOURCES }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("security_prices_security_date_source_uq").on(
      t.securityId,
      t.date,
      t.source,
    ),
    index("security_prices_user_id_idx").on(t.userId),
  ],
);

export const fxRates = sqliteTable(
  "fx_rates",
  {
    id: id(),
    userId: userId(),
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    date: text("date").notNull(),
    /** Units of `quote` per one unit of `base`. */
    rate: fixed("rate").notNull(),
    source: text("source", { enum: PRICE_SOURCES }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("fx_rates_user_pair_date_source_uq").on(
      t.userId,
      t.base,
      t.quote,
      t.date,
      t.source,
    ),
    index("fx_rates_user_id_idx").on(t.userId),
  ],
);

export const marketDataSettings = sqliteTable(
  "market_data_settings",
  {
    id: id(),
    userId: userId(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("market_data_settings_user_id_uq").on(t.userId)],
);

export const portfolios = sqliteTable(
  "portfolios",
  {
    id: id(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The provider's portfolio or relationship number. */
    number: text("number"),
    /** Free text such as the investment strategy. */
    strategy: text("strategy"),
    /** Normalized QRR or SCOR that payments into this portfolio carry; unique per user. */
    depositReference: text("deposit_reference"),
    openedOn: text("opened_on"),
    closedOn: text("closed_on"),
    closeReason: text("close_reason", { enum: PORTFOLIO_CLOSE_REASONS }),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("portfolios_user_id_idx").on(t.userId),
    index("portfolios_account_id_idx").on(t.accountId),
    uniqueIndex("portfolios_user_reference_uq").on(
      t.userId,
      t.depositReference,
    ),
  ],
);

export const portfolioValues = sqliteTable(
  "portfolio_values",
  {
    id: id(),
    userId: userId(),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    /** Account currency; entered by hand. */
    amount: minor("amount").notNull(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("portfolio_values_portfolio_date_uq").on(t.portfolioId, t.date),
    index("portfolio_values_user_id_idx").on(t.userId),
  ],
);

export const pillar3aContributions = sqliteTable(
  "pillar_3a_contributions",
  {
    id: id(),
    userId: userId(),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    /**
     * Set: annotates a payment detected by its reference; kind and date
     * override the defaults, the amount always comes from the transaction.
     * Null: a manually entered contribution.
     */
    transactionId: text("transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),
    /** The credit date; its year is the tax year. */
    date: text("date").notNull(),
    /** CHF, positive. Ignored for annotations (the transaction wins). */
    amount: minor("amount").notNull(),
    kind: text("kind", { enum: PILLAR_3A_CONTRIBUTION_KINDS })
      .notNull()
      .default("ordinary"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("pillar_3a_contributions_user_id_idx").on(t.userId),
    index("pillar_3a_contributions_portfolio_id_idx").on(t.portfolioId),
    uniqueIndex("pillar_3a_contributions_transaction_uq").on(t.transactionId),
  ],
);

export const pillar3aBuyInYears = sqliteTable(
  "pillar_3a_buy_in_years",
  {
    id: id(),
    userId: userId(),
    contributionId: text("contribution_id")
      .notNull()
      .references(() => pillar3aContributions.id, { onDelete: "cascade" }),
    /** The gap year this buy-in closes; each year can be closed only once. */
    year: integer("year").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pillar_3a_buy_in_years_user_year_uq").on(t.userId, t.year),
    index("pillar_3a_buy_in_years_user_id_idx").on(t.userId),
    index("pillar_3a_buy_in_years_contribution_id_idx").on(t.contributionId),
  ],
);

export const pillar3aYears = sqliteTable(
  "pillar_3a_years",
  {
    id: id(),
    userId: userId(),
    year: integer("year").notNull(),
    deduction: text("deduction", { enum: PILLAR_3A_DEDUCTIONS })
      .notNull()
      .default("small"),
    /** Net earned income (CHF) for the large deduction. */
    earnedIncome: minor("earned_income"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pillar_3a_years_user_year_uq").on(t.userId, t.year),
    index("pillar_3a_years_user_id_idx").on(t.userId),
  ],
);
