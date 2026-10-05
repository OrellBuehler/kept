import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Minor } from "$lib/money";
import {
  ACCOUNT_TYPES,
  IMPORT_FORMATS,
  REFERENCE_TYPES,
  ROW_SOURCES,
  TRANSFER_METHODS,
  TRANSFER_STATUSES,
  WITHDRAWAL_PERIODS,
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
import { IBAN_DISPLAY, LOCALES } from "$lib/preferences";
import { nextSeq } from "../seq";
import {
  bool,
  bytes,
  fixed,
  foreignKey,
  index,
  instant,
  int,
  json,
  minor,
  table,
  text,
  timestamps,
  uniqueIndex,
} from "./columns";
import { assertPinMatches, dialect } from "./dialect";

assertPinMatches(dialect);

export {
  ACCOUNT_TYPES,
  IMPORT_FORMATS,
  REFERENCE_TYPES,
  ROW_SOURCES,
  TRANSFER_METHODS,
  TRANSFER_STATUSES,
};
export type {
  AccountType,
  ImportFormat,
  RowSource,
  TransferMethod,
  TransferStatus,
} from "$lib/ledger-types";
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

/**
 * Insertion order; ties between rows with equal sort keys break on it, then on `id`.
 * The value comes from `nextSeq` in drizzle only: the column's database default is 0
 * (migration 0029), so a raw SQL insert would sort before every existing row.
 */
const seq = () => int("seq").notNull().$defaultFn(nextSeq);

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = table("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull().default("member"),
  ...timestamps(),
});

export const sessions = table(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: instant("expires_at").notNull(),
    /** Last step-up authentication (password [+ code]); gates sensitive changes such as passkeys. */
    reauthAt: instant("reauth_at"),
    ...timestamps(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const totpCredentials = table("totp_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-GCM encrypted base32 secret (see crypto.ts). */
  secret: text("secret").notNull(),
  /** Null until the user confirmed a code; unconfirmed rows do not protect the login. */
  confirmedAt: instant("confirmed_at"),
  /** Highest accepted time step; codes at or below it are rejected (replay protection). */
  lastStep: int("last_step").notNull().default(0),
  ...timestamps(),
});

export const recoveryCodes = table(
  "recovery_codes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: instant("used_at"),
    ...timestamps(),
  },
  (t) => [
    index("recovery_codes_user_id_idx").on(t.userId),
    uniqueIndex("recovery_codes_hash_uq").on(t.userId, t.codeHash),
  ],
);

export const passkeys = table(
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
    counter: int("counter").notNull().default(0),
    /** JSON array of AuthenticatorTransport values. */
    transports: text("transports"),
    deviceType: text("device_type").notNull(),
    backedUp: bool("backed_up").notNull(),
    lastUsedAt: instant("last_used_at"),
    ...timestamps(),
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
export const authChallenges = table(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    kind: text("kind", { enum: AUTH_CHALLENGE_KINDS }).notNull(),
    challenge: text("challenge"),
    attempts: int("attempts").notNull().default(0),
    expiresAt: instant("expires_at").notNull(),
    ...timestamps(),
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
export const authEvents = table(
  "auth_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    actorId: text("actor_id").notNull(),
    type: text("type", { enum: AUTH_EVENT_TYPES }).notNull(),
    ...timestamps(),
  },
  (t) => [index("auth_events_user_id_idx").on(t.userId)],
);

export const ADMIN_ACTIONS = [
  "user_create",
  "user_delete",
  "user_reset_two_factor",
  "backup_download",
  "backup_link_issued",
  "admin_confirm_failed",
  "admin_confirm_rate_limited",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * Audit trail of administrator actions. Ids and usernames only, no secrets;
 * not a foreign key so entries outlive deleted users.
 */
export const adminAuditLog = table(
  "admin_audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorUserId: text("actor_user_id").notNull(),
    actorUsername: text("actor_username").notNull(),
    action: text("action", { enum: ADMIN_ACTIONS }).notNull(),
    targetUserId: text("target_user_id"),
    targetUsername: text("target_username"),
    /** Short non-sensitive context such as "role=admin". */
    details: text("details"),
    ...timestamps(),
  },
  (t) => [index("admin_audit_log_created_at_idx").on(t.createdAt)],
);

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const institutions = table(
  "institutions",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    bic: text("bic"),
    color: text("color"),
    logo: bytes("logo"),
    logoMime: text("logo_mime"),
    logoVersion: text("logo_version"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("institutions_user_name_uq").on(t.userId, t.name),
    index("institutions_user_id_idx").on(t.userId),
  ],
);

export const accounts = table(
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
    archived: bool("archived").notNull().default(false),
    /** When the account was archived; past net worth still counts it before this instant. */
    archivedAt: instant("archived_at"),
    sortOrder: int("sort_order").notNull().default(0),
    /** The user's ownership share in basis points (10000 = 100%). Never applied to stored amounts. */
    shareBps: int("share_bps").notNull().default(10000),
    /** Free-text note on who the account is shared with. */
    sharedWith: text("shared_with"),
    /** Provider contract number of a pillar 3a account (free text). */
    contractNumber: text("contract_number"),
    /** IBAN to pay into when the account itself has none (a pillar 3a QR-IBAN); not unique, providers share it. */
    depositIban: text("deposit_iban"),
    /** Months of notice before the balance can be withdrawn; null means available now. */
    noticeMonths: int("notice_months"),
    /** Amount that can be withdrawn without notice per period, account currency. Needs noticeMonths. */
    freeWithdrawal: minor("free_withdrawal"),
    freeWithdrawalPeriod: text("free_withdrawal_period", {
      enum: WITHDRAWAL_PERIODS,
    }),
    /** Create the counter-transaction here when another account shows a transfer to this IBAN. */
    fillFromTransfers: bool("fill_from_transfers").notNull().default(false),
    /** Trades reduce (buys) or increase (sells) the cash balance, for accounts without statements. */
    tradesMoveCash: bool("trades_move_cash").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("accounts_user_iban_uq").on(t.userId, t.iban),
    index("accounts_user_id_idx").on(t.userId),
    index("accounts_institution_id_idx").on(t.institutionId),
  ],
);

export const imports = table(
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
    newCount: int("new_count").notNull().default(0),
    duplicateCount: int("duplicate_count").notNull().default(0),
    /** JSON array of strings. */
    warnings: text("warnings").notNull().default("[]"),
    ...timestamps(),
  },
  (t) => [
    index("imports_user_id_idx").on(t.userId),
    index("imports_account_id_idx").on(t.accountId),
  ],
);

/**
 * An uploaded statement waiting for preview and confirmation. The bytes live in
 * the blob store at `pending-imports/<userId>/<id>`; rows past `expiresAt` are
 * purged together with their blob.
 */
export const pendingImports = table(
  "pending_imports",
  {
    /** 32 random url-safe characters; unguessable, never a uuid. */
    id: text("id").primaryKey(),
    userId: userId(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    format: text("format", { enum: IMPORT_FORMATS }).notNull(),
    fileName: text("file_name").notNull(),
    size: int("size").notNull(),
    sha256: text("sha256").notNull(),
    expiresAt: instant("expires_at").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("pending_imports_user_id_idx").on(t.userId),
    index("pending_imports_expires_at_idx").on(t.expiresAt),
  ],
);

export const INBOX_STATUSES = [
  "imported",
  "review",
  "failed",
  "duplicate",
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const inboxFiles = table(
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
    newCount: int("new_count"),
    duplicateCount: int("duplicate_count"),
    /** File name inside the user's review/ folder while the file awaits review. */
    reviewFile: text("review_file"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("inbox_files_user_sha_uq").on(t.userId, t.sha256),
    index("inbox_files_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const categories = table(
  "categories",
  {
    id: id(),
    userId: userId(),
    /** One level only: a parent never has a parent of its own. */
    parentId: text("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull().default("expense"),
    /** `#rrggbb`. */
    color: text("color"),
    icon: text("icon"),
    ...timestamps(),
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
export const categoryRules = table(
  "category_rules",
  {
    id: id(),
    userId: userId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    priority: int("priority").notNull().default(100),
    counterpartyContains: text("counterparty_contains"),
    descriptionContains: text("description_contains"),
    counterpartyIban: text("counterparty_iban"),
    amountSign: text("amount_sign", { enum: AMOUNT_SIGNS }),
    seq: seq(),
    ...timestamps(),
  },
  (t) => [
    index("category_rules_user_id_idx").on(t.userId),
    index("category_rules_category_id_idx").on(t.categoryId),
  ],
);

/** Monthly budget for a category in one currency; no conversion between currencies. */
export const budgets = table(
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
    ...timestamps(),
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
export const deductionMappings = table(
  "deduction_mappings",
  {
    id: id(),
    userId: userId(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    deductionType: text("deduction_type", { enum: DEDUCTION_TYPES }).notNull(),
    ...timestamps(),
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
export const recurringSeries = table(
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
    edited: bool("edited").notNull().default(false),
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
    occurrences: int("occurrences").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("recurring_series_user_key_uq").on(t.userId, t.key),
    index("recurring_series_user_id_idx").on(t.userId),
  ],
);

export const transactions = table(
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
    /** Dedupe key per account; manual rows use `manual:<uuid>`, mirrors `mirror:<source id>`. */
    externalId: text("external_id").notNull(),
    /** Mirrors only: the transaction this row was created from; the mirror goes when it does. */
    mirrorOfId: text("mirror_of_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "cascade" },
    ),
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
    reversal: bool("reversal").notNull().default(false),
    note: text("note"),
    /** Set by a rule on import or by hand; a manual choice is never overwritten. */
    categoryId: text("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    /** Counts as a payment to the tax office for this tax year. */
    taxYear: int("tax_year"),
    /** Tax year this transaction is deducted in, when not its booking year. Not a tax payment. */
    deductionYear: int("deduction_year"),
    /** Left out of the tax deductions summary. */
    deductionExcluded: bool("deduction_excluded").notNull().default(false),
    seq: seq(),
    ...timestamps(),
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
    index("transactions_mirror_of_id_idx").on(t.mirrorOfId),
    // The ledger lists newest-first by (booking_date, seq). SQLite's
    // migrations are frozen, so this one exists on PostgreSQL only.
    ...(dialect === "pg"
      ? [
          index("transactions_user_booking_seq_idx").on(
            t.userId,
            t.bookingDate,
            t.seq,
          ),
        ]
      : []),
  ],
);

/**
 * A payment between two of the user's own accounts. `linked` ties the two
 * booked sides together (out = the debit, in = the credit); `needs_amount` has
 * only the source side because the other account's currency differs and the
 * received amount is unknown; `dismissed` remembers an unlink so the engine
 * never recreates that pair or mirror.
 */
export const transfers = table(
  "transfers",
  {
    id: id(),
    userId: userId(),
    outTransactionId: text("out_transaction_id").references(
      () => transactions.id,
      { onDelete: "cascade" },
    ),
    inTransactionId: text("in_transaction_id").references(
      () => transactions.id,
      { onDelete: "cascade" },
    ),
    status: text("status", { enum: TRANSFER_STATUSES }).notNull(),
    method: text("method", { enum: TRANSFER_METHODS }).notNull(),
    fromAccountId: text("from_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    toAccountId: text("to_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("transfers_out_transaction_uq").on(t.outTransactionId),
    uniqueIndex("transfers_in_transaction_uq").on(t.inTransactionId),
    index("transfers_user_status_idx").on(t.userId, t.status),
    index("transfers_from_account_idx").on(t.fromAccountId),
    index("transfers_to_account_idx").on(t.toAccountId),
  ],
);

/**
 * Transactions the deduction-year update moved from `tax_year` to `deduction_year`, so the
 * move can be undone. Created by a data migration; a row goes when the user undoes or dismisses it.
 */
export const deductionYearMigration = table(
  "deduction_year_migration",
  {
    id: id(),
    userId: userId(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    oldTaxYear: int("old_tax_year").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("deduction_year_migration_tx_uq").on(t.transactionId),
    index("deduction_year_migration_user_year_idx").on(t.userId, t.oldTaxYear),
  ],
);

export const balanceSnapshots = table(
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
    ...timestamps(),
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

export const csvProfiles = table(
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
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("csv_profiles_account_uq").on(t.accountId),
    index("csv_profiles_user_id_idx").on(t.userId),
  ],
);
export const documents = table(
  "documents",
  {
    id: id(),
    userId: userId(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: int("size").notNull(),
    sha256: text("sha256").notNull(),
    /** Relative to the documents root; built from ids, never from user input. */
    storageKey: text("storage_key").notNull(),
    source: text("source", { enum: DOCUMENT_SOURCES }).notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("documents_user_sha256_uq").on(t.userId, t.sha256),
    index("documents_user_id_idx").on(t.userId),
  ],
);

export const bills = table(
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
    cancelled: bool("cancelled").notNull().default(false),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    expectedAccountId: text("expected_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    /** Payments allocated to this bill count as tax paid for this year. */
    taxYear: int("tax_year"),
    /** Set by an integration adapter; the core does not interpret these. */
    externalSource: text("external_source"),
    externalRef: text("external_ref"),
    externalUrl: text("external_url"),
    /** JSON text: `{ source, warnings }` of the last extraction. */
    extraction: text("extraction"),
    ...timestamps(),
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

export const taxYears = table(
  "tax_years",
  {
    id: id(),
    userId: userId(),
    year: int("year").notNull(),
    /** Free text; no tax office is known to the code. */
    authority: text("authority"),
    currency: text("currency").notNull(),
    /** Minor units, >= 0; the total the assessment says is owed for the year. */
    assessedTotal: minor("assessed_total"),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("tax_years_user_year_uq").on(t.userId, t.year)],
);

/** A line from the tax office's account statement: what they counted as received. */
export const taxCredits = table(
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
    seq: seq(),
    ...timestamps(),
  },
  (t) => [
    index("tax_credits_user_id_idx").on(t.userId),
    index("tax_credits_tax_year_id_idx").on(t.taxYearId),
  ],
);

export const billAllocations = table(
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
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("bill_allocations_pair_uq").on(t.billId, t.transactionId),
    index("bill_allocations_user_id_idx").on(t.userId),
    index("bill_allocations_transaction_id_idx").on(t.transactionId),
  ],
);

export const matchDismissals = table(
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
    ...timestamps(),
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

export const paperlessConnections = table(
  "paperless_connections",
  {
    id: id(),
    userId: userId(),
    baseUrl: text("base_url").notNull(),
    /**
     * Identity of the Paperless server behind this connection; part of every bill's external
     * reference. Survives address changes. Null on rows created before this column existed:
     * their bills carry the hash of the address they were created with.
     */
    instanceKey: text("instance_key"),
    /** Encrypted with `encryptSecret`; never returned to the client. */
    tokenEncrypted: text("token_encrypted").notNull(),
    apiVersion: int("api_version"),
    serverVersion: text("server_version"),
    billSource: json<PaperlessBillSource>("bill_source"),
    fieldMapping: json<PaperlessFieldMapping>("field_mapping"),
    /** SHA-256 (hex) of the webhook secret; the secret itself is shown once. */
    webhookSecretHash: text("webhook_secret_hash").notNull(),
    /** Random, used in the webhook URL path to identify the connection. */
    webhookToken: text("webhook_token").notNull(),
    allowInsecureTls: bool("allow_insecure_tls").notNull().default(false),
    lastSyncAt: instant("last_sync_at"),
    /** Highest Paperless `modified` handled, epoch ms. */
    lastSyncModified: int("last_sync_modified"),
    /** Short machine-readable reason, never document content. */
    lastError: text("last_error"),
    enabled: bool("enabled").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("paperless_connections_user_uq").on(t.userId),
    uniqueIndex("paperless_connections_token_uq").on(t.webhookToken),
  ],
);

export const paperlessDocuments = table(
  "paperless_documents",
  {
    id: id(),
    userId: userId(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => paperlessConnections.id, { onDelete: "cascade" }),
    paperlessId: int("paperless_id").notNull(),
    billId: text("bill_id").references(() => bills.id, {
      onDelete: "set null",
    }),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    /** Paperless `modified` at the last handling, epoch ms. */
    modified: int("modified").notNull(),
    status: text("status", { enum: PAPERLESS_DOCUMENT_STATUSES }).notNull(),
    error: text("error"),
    contentSha256: text("content_sha256"),
    lastPushedHash: text("last_pushed_hash"),
    ...timestamps(),
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

/**
 * A document Paperless could not serve (5xx, timeout) and that is retried. It holds the
 * sync watermark only while it is below the attempt cap; the row goes once it is handled.
 */
export const paperlessPending = table(
  "paperless_pending",
  {
    id: id(),
    userId: userId(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => paperlessConnections.id, { onDelete: "cascade" }),
    paperlessId: int("paperless_id").notNull(),
    attempts: int("attempts").notNull().default(0),
    firstFailedAt: instant("first_failed_at").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("paperless_pending_conn_doc_uq").on(
      t.connectionId,
      t.paperlessId,
    ),
    index("paperless_pending_user_id_idx").on(t.userId),
  ],
);

/** Paperless documents whose bill the user deleted; outlives the connection and its links. */
export const paperlessDismissed = table(
  "paperless_dismissed",
  {
    id: id(),
    userId: userId(),
    /** `externalRef(baseUrl, paperlessId)`, as stored on bills. */
    externalRef: text("external_ref").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("paperless_dismissed_user_ref_uq").on(t.userId, t.externalRef),
  ],
);

/**
 * The instance key a user's connection had at an address, kept after the connection is gone so
 * reconnecting to that address reuses it (bills and dismissed refs carry the key).
 */
export const paperlessInstances = table(
  "paperless_instances",
  {
    id: id(),
    userId: userId(),
    baseUrl: text("base_url").notNull(),
    instanceKey: text("instance_key").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("paperless_instances_user_url_uq").on(t.userId, t.baseUrl),
  ],
);

export const paperlessReportUploads = table(
  "paperless_report_uploads",
  {
    id: id(),
    userId: userId(),
    connectionId: text("connection_id").notNull(),
    reportKind: text("report_kind").notNull(),
    sha256: text("sha256").notNull(),
    paperlessDocumentId: int("paperless_document_id"),
    taskId: text("task_id"),
    status: text("status", { enum: PAPERLESS_UPLOAD_STATUSES }).notNull(),
    error: text("error"),
    ...timestamps(),
  },
  (t) => [
    // Named explicitly: the generated name is over PostgreSQL's 63-byte limit.
    foreignKey({
      name: "paperless_report_uploads_connection_id_fk",
      columns: [t.connectionId],
      foreignColumns: [paperlessConnections.id],
    }).onDelete("cascade"),
    uniqueIndex("paperless_report_uploads_conn_sha_uq").on(
      t.connectionId,
      t.sha256,
    ),
    index("paperless_report_uploads_user_id_idx").on(t.userId),
  ],
);

/** Which notification triggers a user has switched on, with their parameters. */
export const notificationSettings = table("notification_settings", {
  id: id(),
  userId: userId().unique(),
  billDueEnabled: bool("bill_due_enabled").notNull().default(false),
  billDueDays: int("bill_due_days").notNull().default(3),
  billOverdueEnabled: bool("bill_overdue_enabled").notNull().default(false),
  budgetEnabled: bool("budget_enabled").notNull().default(false),
  /** Notify once spending reaches this share of a monthly budget. */
  budgetPercent: int("budget_percent").notNull().default(100),
  staleImportEnabled: bool("stale_import_enabled").notNull().default(false),
  staleImportDays: int("stale_import_days").notNull().default(14),
  ...timestamps(),
});

/** One delivery channel per kind and user. */
export const notificationChannels = table(
  "notification_channels",
  {
    id: id(),
    userId: userId(),
    kind: text("kind", { enum: CHANNEL_KINDS }).notNull(),
    /** JSON, encrypted with `encryptSecret`; never returned to the client. */
    configEncrypted: text("config_encrypted").notNull(),
    enabled: bool("enabled").notNull().default(true),
    lastSuccessAt: instant("last_success_at"),
    /** Short reason, never message content. */
    lastError: text("last_error"),
    lastErrorAt: instant("last_error_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("notification_channels_user_kind_uq").on(t.userId, t.kind),
  ],
);

/** Events already notified, so each one is sent once. */
export const notificationsSent = table(
  "notifications_sent",
  {
    id: id(),
    userId: userId(),
    /** e.g. `bill-overdue:<billId>:<dueDate>`. */
    eventKey: text("event_key").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("notifications_sent_user_key_uq").on(t.userId, t.eventKey),
  ],
);

/** One-off expected income or expense used by the cash-flow forecast. */
export const plannedItems = table(
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
    ...timestamps(),
  },
  (t) => [
    index("planned_items_user_date_idx").on(t.userId, t.date),
    index("planned_items_account_id_idx").on(t.accountId),
  ],
);

/** Per-account forecast preferences: low-balance threshold and default payment account. */
export const forecastAccountSettings = table(
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
    isDefaultPayment: bool("is_default_payment").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("forecast_account_settings_account_uq").on(t.accountId),
    index("forecast_account_settings_user_id_idx").on(t.userId),
  ],
);

export const userPreferences = table(
  "user_preferences",
  {
    id: id(),
    userId: userId(),
    ibanDisplay: text("iban_display", { enum: IBAN_DISPLAY }).notNull(),
    blurAmounts: bool("blur_amounts").notNull(),
    locale: text("locale", { enum: LOCALES }).notNull(),
    defaultCurrency: text("default_currency").notNull(),
    pageSize: int("page_size").notNull(),
    /** Count the cash part of investment accounts as liquid. */
    investmentCashLiquid: bool("investment_cash_liquid")
      .notNull()
      .default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex("user_preferences_user_id_uq").on(t.userId)],
);

export const securities = table(
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
    ...timestamps(),
  },
  (t) => [index("securities_user_id_idx").on(t.userId)],
);

export const trades = table(
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
    /** Split only: the exact integer ratio `splitNew : splitOld`; `quantity` is its Fixed8 approximation. */
    splitNew: int("split_new"),
    splitOld: int("split_old"),
    note: text("note"),
    seq: seq(),
    ...timestamps(),
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

export const securityPrices = table(
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
    ...timestamps(),
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

export const fxRates = table(
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
    ...timestamps(),
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

export const marketDataSettings = table(
  "market_data_settings",
  {
    id: id(),
    userId: userId(),
    enabled: bool("enabled").notNull().default(false),
    lastRunAt: instant("last_run_at"),
    lastError: text("last_error"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("market_data_settings_user_id_uq").on(t.userId)],
);

export const portfolios = table(
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
    sortOrder: int("sort_order").notNull().default(0),
    ...timestamps(),
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

export const portfolioValues = table(
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
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("portfolio_values_portfolio_date_uq").on(t.portfolioId, t.date),
    index("portfolio_values_user_id_idx").on(t.userId),
  ],
);

export const pillar3aContributions = table(
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
    ...timestamps(),
  },
  (t) => [
    index("pillar_3a_contributions_user_id_idx").on(t.userId),
    index("pillar_3a_contributions_portfolio_id_idx").on(t.portfolioId),
    uniqueIndex("pillar_3a_contributions_transaction_uq").on(t.transactionId),
  ],
);

export const pillar3aBuyInYears = table(
  "pillar_3a_buy_in_years",
  {
    id: id(),
    userId: userId(),
    contributionId: text("contribution_id").notNull(),
    /** The gap year this buy-in closes; each year can be closed only once. */
    year: int("year").notNull(),
    ...timestamps(),
  },
  (t) => [
    // Named explicitly: the generated name is over PostgreSQL's 63-byte limit.
    foreignKey({
      name: "pillar_3a_buy_in_years_contribution_id_fk",
      columns: [t.contributionId],
      foreignColumns: [pillar3aContributions.id],
    }).onDelete("cascade"),
    uniqueIndex("pillar_3a_buy_in_years_user_year_uq").on(t.userId, t.year),
    index("pillar_3a_buy_in_years_user_id_idx").on(t.userId),
    index("pillar_3a_buy_in_years_contribution_id_idx").on(t.contributionId),
  ],
);

export const pillar3aYears = table(
  "pillar_3a_years",
  {
    id: id(),
    userId: userId(),
    year: int("year").notNull(),
    deduction: text("deduction", { enum: PILLAR_3A_DEDUCTIONS })
      .notNull()
      .default("small"),
    /** Net earned income (CHF) for the large deduction. */
    earnedIncome: minor("earned_income"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pillar_3a_years_user_year_uq").on(t.userId, t.year),
    index("pillar_3a_years_user_id_idx").on(t.userId),
  ],
);
