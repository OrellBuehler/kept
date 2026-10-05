import { and, desc, eq, inArray } from "drizzle-orm";
import { maskIban, normalizeIban } from "$lib/iban";
import { formatAmount, minor, type Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  first,
  getDB,
  imports,
  transactions,
} from "$lib/server/db";
import { parseCamt053 } from "$lib/server/importers/camt053";
import { parseTabular } from "$lib/server/importers/csv";
import { readCsv, readXlsx } from "$lib/server/importers/tabular";
import type { CsvMappingProfile } from "$lib/server/importers/mapping";
import {
  ImportFormatError,
  type NormalizedBalance,
  type NormalizedStatement,
  type NormalizedTransaction,
} from "$lib/server/importers/types";
import { notFound } from "$lib/server/ledger/errors";
import { getAccount, type AccountView } from "$lib/server/ledger/accounts";
import { findReplacements } from "$lib/server/transfers/replace";
import {
  balanceAt,
  cashMovesOf,
  ledgerMoves,
  type BalanceInput,
} from "$lib/server/ledger/balances";
import { loadHoldingsInputs } from "$lib/server/investments/load";
import { getCsvProfile } from "./profiles";
import { cachedParse } from "./cache";
import { getPendingMeta, readPending, type PendingMeta } from "./pending";

/**
 * `replaces_mirror`: a new row that takes over a mirrored transaction Kept created from a
 * transfer on another account (same amount, within five days); it is imported like a new row.
 */
export type RowStatus =
  "new" | "replaces_mirror" | "duplicate" | "duplicate_in_file";

export interface PreviewRowView {
  /** 1-based position in the file's transaction list. */
  index: number;
  status: RowStatus;
  /** Why a `duplicate` row counts as imported: its current id, or only an id earlier versions derived. */
  matchedBy: "id" | "legacy_id" | null;
  /** `replaces_mirror` only: the mirrored transaction this row takes over. */
  mirrorId: string | null;
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
  /** `new` counts every row that will be imported, replacements included. */
  counts: {
    new: number;
    replacesMirror: number;
    duplicate: number;
    total: number;
  };
  warnings: string[];
  /** Balance mismatches; amounts are rendered client-side so display preferences apply. */
  balanceWarnings: BalanceWarning[];
  errors: string[];
  /** Instant (ms) of the most recent import of this exact file into this account. */
  alreadyImportedAt: number | null;
}

export const TRADES_MOVE_CASH_MESSAGE =
  "Turn off 'Trades move cash' for this account before importing statements: the statement already contains the trade bookings.";

export const MAPPING_REQUIRED = "mapping_required";

export interface PreviewOptions {
  /** Overrides the account's saved mapping (csv/xlsx only). */
  profile?: CsvMappingProfile;
}

/** The declared period, or the first and last booking date when the file declares none. */
function statementPeriod(statement: NormalizedStatement): {
  fromDate: string | null;
  toDate: string | null;
} {
  const dates = statement.transactions.map((t) => t.bookingDate).sort();
  return {
    fromDate: statement.fromDate ?? dates[0] ?? null,
    toDate: statement.toDate ?? dates[dates.length - 1] ?? null,
  };
}

// --- statement selection ---------------------------------------------------

function mergeStatements(list: NormalizedStatement[]): NormalizedStatement {
  if (list.length === 1) return list[0]!;
  const byOpening = list
    .filter((s) => s.openingBalance)
    .sort((a, b) =>
      a.openingBalance!.date.localeCompare(b.openingBalance!.date),
    );
  const byClosing = list
    .filter((s) => s.closingBalance)
    .sort((a, b) =>
      b.closingBalance!.date.localeCompare(a.closingBalance!.date),
    );
  const dates = (pick: (s: NormalizedStatement) => string | null) =>
    list
      .map(pick)
      .filter((d): d is string => d !== null)
      .sort();
  const froms = dates((s) => s.fromDate);
  const tos = dates((s) => s.toDate);
  return {
    ...list[0]!,
    fromDate: froms[0] ?? null,
    toDate: tos[tos.length - 1] ?? null,
    openingBalance: byOpening[0]?.openingBalance ?? null,
    closingBalance: byClosing[0]?.closingBalance ?? null,
    transactions: list.flatMap((s) => s.transactions),
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
    if (only.accountIban && accountIban) {
      return {
        statement: null,
        warnings: [],
        errors: [
          `The statement is for a different IBAN (${maskIban(only.accountIban)}) than this account (${maskIban(accountIban)}).`,
        ],
      };
    }
    const warning = !only.accountIban
      ? "The statement does not name an account IBAN, so it cannot be checked against this account."
      : "This account has no IBAN, so the statement's account could not be verified.";
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

async function loadLedger(
  userId: string,
  accountId: string,
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<BalanceInput> {
  const db = getDB();
  const account = await first(
    db
      .select({
        openingBalance: accounts.openingBalance,
        openingDate: accounts.openingDate,
        tradesMoveCash: accounts.tradesMoveCash,
      })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!account) throw notFound("Account");
  return {
    openingBalance: account.openingBalance,
    openingDate: account.openingDate,
    cashMoves: account.tradesMoveCash
      ? cashMovesOf(
          (await loadHoldingsInputs(userId, [accountId], "9999-12-31")).get(
            accountId,
          ),
        )
      : undefined,
    transactions: (
      await db
        .select({
          id: transactions.id,
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
    ).filter((t) => !excludeIds.has(t.id)),
    snapshots: await db
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
      ),
  };
}

function hasDataBefore(input: BalanceInput, date: string): boolean {
  return (
    (input.openingDate !== null && input.openingDate < date) ||
    input.snapshots.some((s) => s.date < date) ||
    ledgerMoves(input).some((t) => t.bookingDate < date)
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
  const between = ledgerMoves(input)
    .filter((t) => t.bookingDate > date && t.bookingDate <= later.date)
    .reduce((sum, t) => sum + t.amount, 0);
  return minor(later.amount - between);
}

export type BalanceWarning =
  | {
      code: "opening_mismatch";
      date: string;
      fileAmount: Minor;
      ledgerAmount: Minor;
      currency: string;
    }
  | {
      code: "closing_mismatch";
      date: string;
      fileAmount: Minor;
      ledgerAmount: Minor;
      currency: string;
    };

/** Plain-text form, for the persisted import history. */
export function balanceWarningText(w: BalanceWarning): string {
  const tail =
    "This usually means a gap between imports or missing transactions.";
  return w.code === "opening_mismatch"
    ? `The file's opening balance (${formatAmount(w.fileAmount, w.currency)} on ${w.date}) does not match the ledger balance at the end of the previous day (${formatAmount(w.ledgerAmount, w.currency)}). ${tail}`
    : `After this import the ledger balance on ${w.date} would be ${formatAmount(w.ledgerAmount, w.currency)}, but the file's closing balance is ${formatAmount(w.fileAmount, w.currency)}. ${tail}`;
}

function continuityWarnings(
  input: BalanceInput,
  statement: NormalizedStatement,
  newRows: NormalizedTransaction[],
  currency: string,
): BalanceWarning[] {
  const warnings: BalanceWarning[] = [];
  const opening = statement.openingBalance;
  if (opening && hasDataBefore(input, opening.date)) {
    const ledger = anchoredBalanceAt(input, previousDay(opening.date));
    if (ledger !== null && ledger !== opening.amount) {
      warnings.push({
        code: "opening_mismatch",
        date: opening.date,
        fileAmount: opening.amount,
        ledgerAmount: ledger,
        currency,
      });
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
      warnings.push({
        code: "closing_mismatch",
        date: closing.date,
        fileAmount: closing.amount,
        ledgerAmount: ledger,
        currency,
      });
    }
  }
  return warnings;
}

// --- preview ---------------------------------------------------------------

async function parseFile(
  meta: PendingMeta,
  readBytes: () => Promise<Uint8Array>,
  profile: CsvMappingProfile | null,
  account: AccountView,
): Promise<Selection> {
  try {
    if (meta.format === "camt053") {
      return selectCamtStatement(
        await cachedParse(meta, "camt", async () =>
          parseCamt053(new TextDecoder("utf-8").decode(await readBytes())),
        ),
        account,
      );
    }
    if (!profile) {
      return { statement: null, warnings: [], errors: [MAPPING_REQUIRED] };
    }
    const rows =
      meta.format === "xlsx"
        ? await cachedParse(
            meta,
            `xlsx:${profile.decimalSeparator}`,
            async () =>
              readXlsx(await readBytes(), {
                decimalSeparator: profile.decimalSeparator,
              }),
          )
        : await cachedParse(
            meta,
            `csv:${profile.delimiter}:${profile.encoding}`,
            async () =>
              readCsv(await readBytes(), {
                delimiter: profile.delimiter,
                encoding: profile.encoding,
              }),
          );
    const statement = parseTabular(rows, profile);
    return { statement, warnings: [], errors: [] };
  } catch (err) {
    // Importer messages name rows and columns, never cell values.
    if (err instanceof ImportFormatError) {
      return { statement: null, warnings: [], errors: [err.message] };
    }
    throw err;
  }
}

async function existingExternalIds(
  userId: string,
  accountId: string,
  ids: string[],
): Promise<Set<string>> {
  const db = getDB();
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db
      .select({ id: transactions.externalId })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.accountId, accountId),
          inArray(transactions.externalId, chunk),
        ),
      );
    for (const r of rows) found.add(r.id);
  }
  return found;
}

export async function buildPreview(
  userId: string,
  pendingId: string,
  options: PreviewOptions = {},
): Promise<ImportPreview> {
  const meta = await getPendingMeta(userId, pendingId);
  const account = await getAccount(userId, meta.accountId);
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
    balanceWarnings: [] as BalanceWarning[],
  };

  const alreadyImported = await first(
    getDB()
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
      .limit(1),
  );
  const alreadyImportedAt = alreadyImported
    ? alreadyImported.createdAt.getTime()
    : null;

  const profile =
    meta.format === "camt053"
      ? null
      : (options.profile ??
        (await getCsvProfile(userId, account.id))?.profile ??
        null);
  const selection = await parseFile(
    meta,
    async () => (await readPending(userId, pendingId)).bytes,
    profile,
    account,
  );
  const warnings = [...selection.warnings];
  const errors = [...selection.errors];
  const statement = selection.statement;

  if (!statement || errors.length > 0) {
    return {
      ...base,
      statement: null,
      rows: [],
      counts: { new: 0, replacesMirror: 0, duplicate: 0, total: 0 },
      warnings,
      errors,
      alreadyImportedAt,
    };
  }

  if (account.tradesMoveCash) errors.push(TRADES_MOVE_CASH_MESSAGE);
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

  const existing = await existingExternalIds(
    userId,
    account.id,
    statement.transactions.flatMap((t) => [
      t.externalId,
      ...(t.legacyExternalIds ?? []),
    ]),
  );
  const seen = new Set<string>();
  const rows: PreviewRowView[] = statement.transactions.map((tx, i) => {
    let status: RowStatus;
    let matchedBy: PreviewRowView["matchedBy"] = null;
    if (existing.has(tx.externalId)) {
      status = "duplicate";
      matchedBy = "id";
    } else if (tx.legacyExternalIds?.some((id) => existing.has(id))) {
      status = "duplicate";
      matchedBy = "legacy_id";
    } else if (seen.has(tx.externalId)) status = "duplicate_in_file";
    else status = "new";
    seen.add(tx.externalId);
    return { index: i + 1, status, matchedBy, mirrorId: null, tx };
  });

  // New rows that take over a mirror: the mirror goes, so it leaves the continuity check.
  const replacements = await findReplacements(
    userId,
    account.id,
    rows
      .filter((r) => r.status === "new")
      .map((r) => ({
        key: String(r.index),
        bookingDate: r.tx.bookingDate,
        amount: r.tx.amount,
        counterpartyIban: r.tx.counterpartyIban,
        reference: r.tx.reference,
        description: r.tx.description,
      })),
  );
  for (const r of rows) {
    const mirrorId = replacements.get(String(r.index));
    if (mirrorId === undefined) continue;
    r.status = "replaces_mirror";
    r.mirrorId = mirrorId;
  }
  const newRows = rows.filter(
    (r) => r.status === "new" || r.status === "replaces_mirror",
  );
  if (statement.transactions.length === 0) {
    warnings.push("The file contains no transactions.");
  }
  const balanceWarnings: BalanceWarning[] = [];
  if (errors.length === 0) {
    balanceWarnings.push(
      ...continuityWarnings(
        await loadLedger(userId, account.id, new Set(replacements.values())),
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
      ...statementPeriod(statement),
      openingBalance: statement.openingBalance,
      closingBalance: statement.closingBalance,
    },
    rows,
    counts: {
      new: newRows.length,
      replacesMirror: replacements.size,
      duplicate: rows.length - newRows.length,
      total: rows.length,
    },
    warnings,
    balanceWarnings,
    errors,
    alreadyImportedAt,
  };
}
