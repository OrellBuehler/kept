import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
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
import { AMOUNT_SIGNS, CATEGORY_KINDS } from "$lib/category-types";
import type { Minor } from "$lib/money";

export { ACCOUNT_TYPES, IMPORT_FORMATS, REFERENCE_TYPES, ROW_SOURCES };
export type { AccountType, ImportFormat, RowSource } from "$lib/ledger-types";
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
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
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

export const institutions = sqliteTable(
  "institutions",
  {
    id: id(),
    userId: userId(),
    name: text("name").notNull(),
    bic: text("bic"),
    color: text("color"),
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
