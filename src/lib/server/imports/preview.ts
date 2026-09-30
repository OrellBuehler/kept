import { and, desc, eq, inArray } from "drizzle-orm";
import { maskIban, normalizeIban } from "$lib/iban";
import { formatAmount, minor, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  getDB,
  imports,
  transactions,
} from "$lib/server/db";
import { parseCamt053 } from "$lib/server/importers/camt053";
import { parseCsvFile, parseXlsxFile } from "$lib/server/importers/csv";
import type { CsvMappingProfile } from "$lib/server/importers/mapping";
import {
  ImportFormatError,
  type NormalizedBalance,
  type NormalizedStatement,
  type NormalizedTransaction,
} from "$lib/server/importers/types";
import { getAccount, type AccountView } from "$lib/server/ledger/accounts";
import { balanceAt, type BalanceInput } from "$lib/server/ledger/balances";
import { getCsvProfile } from "./profiles";
import { readPending, type PendingMeta } from "./pending";

export type RowStatus = "new" | "duplicate" | "duplicate_in_file";

export interface PreviewRowView {
  /** 1-based position in the file's transaction list. */
  index: number;
  status: RowStatus;
  tx: NormalizedTransaction;
}

export interface StatementSummary {
  accountIban: string | null;
  currency: string;
  fromDate: string | null;
  toDate: string | null;
  openingBalance: NormalizedBalance | null;
  closingBalance: NormalizedBalance | null;
}

export interface ImportPreview {
  pendingId: string;
  account: {
    id: string;
    name: string;
    currency: string;
    iban: string | null;
  };
  format: PendingMeta["format"];
  fileName: string;
  statement: StatementSummary | null;
  rows: PreviewRowView[];
  counts: { new: number; duplicate: number; total: number };
  warnings: string[];
  errors: string[];
  /** Instant (ms) of the most recent import of this exact file into this account. */
  alreadyImportedAt: number | null;
}

export const MAPPING_REQUIRED = "mapping_required";

export interface PreviewOptions {
  /** Overrides the account's saved mapping (csv/xlsx only). */
  profile?: CsvMappingProfile;
}

// --- statement selection ---------------------------------------------------

function mergeStatements(list: NormalizedStatement[]): NormalizedStatement {
  if (list.length === 1) return list[0]!;
  const sorted = [...list].sort((a, b) =>
    (a.fromDate ?? a.openingBalance?.date ?? "").localeCompare(
      b.fromDate ?? b.openingBalance?.date ?? "",
    ),
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    ...first,
    fromDate: first.fromDate,
    toDate: last.toDate,
    openingBalance: first.openingBalance,
    closingBalance: last.closingBalance,
    transactions: sorted.flatMap((s) => s.transactions),
  };
}

interface Selection {
  statement: NormalizedStatement | null;
  warnings: string[];
  errors: string[];
}

function selectCamtStatement(
  statements: NormalizedStatement[],
  account: AccountView,
): Selection {
  const accountIban = account.iban ? normalizeIban(account.iban) : null;
  const matching = accountIban
    ? statements.filter(
        (s) => s.accountIban && normalizeIban(s.accountIban) === accountIban,
      )
    : [];
  if (matching.length > 0) {
    return { statement: mergeStatements(matching), warnings: [], errors: [] };
  }
  if (statements.length === 1) {
    const only = statements[0]!;
    const warning = !only.accountIban
      ? "The statement does not name an account IBAN, so it cannot be checked against this account."
      : !accountIban
        ? "This account has no IBAN, so the statement's account could not be verified."
        : `The statement is for a different IBAN (${maskIban(only.accountIban)}) than this account (${maskIban(accountIban)}).`;
    return { statement: only, warnings: [warning], errors: [] };
  }
  const listed = statements
    .map((s) => (s.accountIban ? maskIban(s.accountIban) : "unknown account"))
    .join(", ");
  return {
    statement: null,
    warnings: [],
    errors: [
      `None of the ${statements.length} statements in this file belongs to this account. The file contains: ${listed}.`,
    ],
  };
}

// --- continuity ------------------------------------------------------------

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function loadLedger(userId: string, accountId: string): BalanceInput {
  const db = getDB();
  const account = db
    .select({
      openingBalance: accounts.openingBalance,
      openingDate: accounts.openingDate,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get()!;
  return {
    openingBalance: account.openingBalance,
    openingDate: account.openingDate,
    transactions: db
      .select({
        bookingDate: transactions.bookingDate,
        amount: transactions.amount,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
        ),
      )
      .all(),
    snapshots: db
      .select({
        date: balanceSnapshots.date,
        amount: balanceSnapshots.amount,
        source: balanceSnapshots.source,
      })
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.userId, userId),
          eq(balanceSnapshots.accountId, accountId),
        ),
      )
      .all(),
  };
}

function hasDataBefore(input: BalanceInput, date: string): boolean {
  return (
    (input.openingDate !== null && input.openingDate < date) ||
    input.snapshots.some((s) => s.date < date) ||
    input.transactions.some((t) => t.bookingDate < date)
  );
}

/**
 * End-of-day ledger balance for a continuity check, or null when nothing
 * anchors the ledger yet (only un-anchored transactions). With a snapshot or
 * opening balance on or before `date` this is the regular ledger balance;
 * otherwise it is derived backwards from the earliest later snapshot, which
 * is how a file that starts after an earlier import is compared.
 */
export function anchoredBalanceAt(
  input: BalanceInput,
  date: string,
): Minor | null {
  const anchoredBefore =
    (input.openingDate !== null && input.openingDate <= date) ||
    input.snapshots.some((s) => s.date <= date);
  if (anchoredBefore) return balanceAt(input, date);
  const later = input.snapshots
    .filter((s) => s.date > date)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        Number(b.source === "manual") - Number(a.source === "manual"),
    )[0];
  if (!later) return null;
  const between = input.transactions
    .filter((t) => t.bookingDate > date && t.bookingDate <= later.date)
    .reduce((sum, t) => sum + t.amount, 0);
  return minor(later.amount - between);
}

function continuityWarnings(
  input: BalanceInput,
  statement: NormalizedStatement,
  newRows: NormalizedTransaction[],
  currency: string,
): string[] {
  const warnings: string[] = [];
  const opening = statement.openingBalance;
  if (opening && hasDataBefore(input, opening.date)) {
    const ledger = anchoredBalanceAt(input, previousDay(opening.date));
    if (ledger !== null && ledger !== opening.amount) {
      warnings.push(
        `The file's opening balance (${formatAmount(opening.amount, currency)} on ${opening.date}) does not match the ledger balance at the end of the previous day (${formatAmount(ledger, currency)}). This usually means a gap between imports or missing transactions.`,
      );
    }
  }
  const closing = statement.closingBalance;
  if (closing) {
    const after: BalanceInput = {
      ...input,
      transactions: [
        ...input.transactions,
        ...newRows.map((t) => ({
          bookingDate: t.bookingDate,
          amount: t.amount,
        })),
      ],
    };
    const ledger = anchoredBalanceAt(after, closing.date);
    if (ledger !== null && ledger !== closing.amount) {
      warnings.push(
        `After this import the ledger balance on ${closing.date} would be ${formatAmount(ledger, currency)}, but the file's closing balance is ${formatAmount(closing.amount, currency)}. This usually means a gap between imports or missing transactions.`,
      );
    }
  }
  return warnings;
}

// --- preview ---------------------------------------------------------------

function parseFile(
  meta: PendingMeta,
  bytes: Uint8Array,
  profile: CsvMappingProfile | null,
  account: AccountView,
): Selection {
  try {
    if (meta.format === "camt053") {
      return selectCamtStatement(
        parseCamt053(new TextDecoder("utf-8").decode(bytes)),
        account,
      );
    }
    if (!profile) {
      return { statement: null, warnings: [], errors: [MAPPING_REQUIRED] };
    }
    const statement =
      meta.format === "xlsx"
        ? parseXlsxFile(bytes, profile)
        : parseCsvFile(bytes, profile);
    return { statement, warnings: [], errors: [] };
  } catch (err) {
    // Importer messages name rows and columns, never cell values.
    if (err instanceof ImportFormatError) {
      return { statement: null, warnings: [], errors: [err.message] };
    }
    throw err;
  }
}

function existingExternalIds(
  userId: string,
  accountId: string,
  ids: string[],
): Set<string> {
  const db = getDB();
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db
      .select({ id: transactions.externalId })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
          inArray(transactions.externalId, chunk),
        ),
      )
      .all()) {
      found.add(r.id);
    }
  }
  return found;
}

export function buildPreview(
  userId: string,
  pendingId: string,
  options: PreviewOptions = {},
): ImportPreview {
  const { meta, bytes } = readPending(userId, pendingId);
  const account = getAccount(userId, meta.accountId);
  const base = {
    pendingId: meta.id,
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      iban: account.iban,
    },
    format: meta.format,
    fileName: meta.fileName,
  };

  const alreadyImported = getDB()
    .select({ createdAt: imports.createdAt })
    .from(imports)
    .where(
      and(
        eq(imports.userId, userId),
        eq(imports.accountId, account.id),
        eq(imports.fileSha256, meta.sha256),
      ),
    )
    .orderBy(desc(imports.createdAt))
    .get();
  const alreadyImportedAt = alreadyImported
    ? alreadyImported.createdAt.getTime()
    : null;

  const profile =
    meta.format === "camt053"
      ? null
      : (options.profile ?? getCsvProfile(userId, account.id)?.profile ?? null);
  const selection = parseFile(meta, bytes, profile, account);
  const warnings = [...selection.warnings];
  const errors = [...selection.errors];
  const statement = selection.statement;

  if (!statement || errors.length > 0) {
    return {
      ...base,
      statement: null,
      rows: [],
      counts: { new: 0, duplicate: 0, total: 0 },
      warnings,
      errors,
      alreadyImportedAt,
    };
  }

  if (statement.currency !== "XXX" && statement.currency !== account.currency) {
    errors.push(
      `The file is in ${statement.currency}, but this account is in ${account.currency}.`,
    );
  } else if (
    statement.transactions.some((t) => t.currency !== account.currency)
  ) {
    errors.push(
      `Some transactions are not in the account currency (${account.currency}).`,
    );
  }

  const existing = existingExternalIds(
    userId,
    account.id,
    statement.transactions.map((t) => t.externalId),
  );
  const seen = new Set<string>();
  const rows: PreviewRowView[] = statement.transactions.map((tx, i) => {
    let status: RowStatus;
    if (existing.has(tx.externalId)) status = "duplicate";
    else if (seen.has(tx.externalId)) status = "duplicate_in_file";
    else status = "new";
    seen.add(tx.externalId);
    return { index: i + 1, status, tx };
  });
  const newRows = rows.filter((r) => r.status === "new");

  if (statement.transactions.length === 0) {
    warnings.push("The file contains no transactions.");
  }
  if (errors.length === 0) {
    warnings.push(
      ...continuityWarnings(
        loadLedger(userId, account.id),
        statement,
        newRows.map((r) => r.tx),
        account.currency,
      ),
    );
  }

  return {
    ...base,
    statement: {
      accountIban: statement.accountIban,
      currency: statement.currency,
      fromDate: statement.fromDate,
      toDate: statement.toDate,
      openingBalance: statement.openingBalance,
      closingBalance: statement.closingBalance,
    },
    rows,
    counts: {
      new: newRows.length,
      duplicate: rows.length - newRows.length,
      total: rows.length,
    },
    warnings,
    errors,
    alreadyImportedAt,
  };
}
