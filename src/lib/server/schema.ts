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
import type { Minor } from "$lib/money";

export { ACCOUNT_TYPES, IMPORT_FORMATS, REFERENCE_TYPES, ROW_SOURCES };
export type { AccountType, ImportFormat, RowSource } from "$lib/ledger-types";

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
