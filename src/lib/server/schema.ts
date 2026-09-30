import { sql } from "drizzle-orm";
import {
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
    ...timestamps,
  },
  (t) => [
    uniqueIndex("transactions_account_external_uq").on(
      t.accountId,
      t.externalId,
    ),
    index("transactions_account_booking_idx").on(t.accountId, t.bookingDate),
    index("transactions_user_id_idx").on(t.userId),
    index("transactions_import_id_idx").on(t.importId),
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
    /** Reserved for tax reconciliation; stored as given. */
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
