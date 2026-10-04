import { eq, sql } from "drizzle-orm";
import { balanceSnapshots, getDB, imports, transactions } from "$lib/server/db";
import type { CsvMappingProfile } from "$lib/server/importers/mapping";
import { categorize, loadRules } from "$lib/server/categories/rules";
import { getAccount } from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { linkAfterWrite } from "$lib/server/transfers/link";
import { takeOverMirror } from "$lib/server/transfers/replace";
import { deletePending, getPendingMeta } from "./pending";
import { balanceWarningText, buildPreview } from "./preview";
import { describeError } from "$lib/server/errors";

export interface ConfirmResult {
  importId: string;
  accountId: string;
  newCount: number;
  duplicateCount: number;
  /** Transfers between the user's own accounts that this import linked. */
  transfers: {
    /** Both sides existed: two real rows linked. */
    paired: number;
    /** A counter-transaction was created on another account. */
    mirrored: number;
    /** New rows that took over a mirrored transaction. */
    replaced: number;
    /** FX transfers waiting for the received amount. */
    needsAmount: number;
  };
}

const INSERT_CHUNK = 100;

/**
 * Imports a pending upload in one database transaction. The preview is
 * rebuilt from the stored file, so nothing the client sends (counts, rows)
 * is trusted; rows that appeared in the ledger meanwhile are skipped by the
 * (account, external id) unique index. The pending file is removed afterwards.
 */
export function confirmImport(
  userId: string,
  pendingId: string,
  options: { profile?: CsvMappingProfile } = {},
): ConfirmResult {
  const preview = buildPreview(userId, pendingId, options);
  if (preview.errors.length > 0) {
    throw new LedgerError("invalid", preview.errors.join(" "));
  }
  const { statement } = preview;
  if (!statement) throw new LedgerError("invalid", "Nothing to import.");
  if (getAccount(userId, preview.account.id).archived) {
    throw new LedgerError(
      "invalid",
      "This account is archived; unarchive it to import into it.",
    );
  }

  const sha = getPendingMeta(userId, pendingId).sha256;
  const accountId = preview.account.id;
  const newRows = preview.rows.filter(
    (r) => r.status === "new" || r.status === "replaces_mirror",
  );
  const rules = loadRules(userId);

  const result = getDB().transaction((tx) => {
    const imp = tx
      .insert(imports)
      .values({
        userId,
        accountId,
        format: preview.format,
        fileName: preview.fileName,
        fileSha256: sha,
        statementFrom: statement.fromDate,
        statementTo: statement.toDate,
        openingBalance: statement.openingBalance?.amount ?? null,
        openingBalanceDate: statement.openingBalance?.date ?? null,
        closingBalance: statement.closingBalance?.amount ?? null,
        closingBalanceDate: statement.closingBalance?.date ?? null,
        newCount: newRows.length,
        duplicateCount: preview.counts.duplicate,
        warnings: JSON.stringify([
          ...preview.warnings,
          ...preview.balanceWarnings.map(balanceWarningText),
        ]),
      })
      .returning({ id: imports.id })
      .get();

    const insertedRows: { id: string; externalId: string }[] = [];
    for (let i = 0; i < newRows.length; i += INSERT_CHUNK) {
      insertedRows.push(
        ...tx
          .insert(transactions)
          .values(
            newRows.slice(i, i + INSERT_CHUNK).map(({ tx: t }) => ({
              userId,
              accountId,
              importId: imp.id,
              source: "import" as const,
              externalId: t.externalId,
              bookingDate: t.bookingDate,
              valueDate: t.valueDate,
              amount: t.amount,
              currency: t.currency,
              originalAmount: t.originalAmount,
              originalCurrency: t.originalCurrency,
              counterpartyName: t.counterpartyName,
              counterpartyIban: t.counterpartyIban,
              description: t.description,
              reference: t.reference,
              referenceType: t.referenceType,
              reversal: t.reversal,
              categoryId: categorize(rules, t),
            })),
          )
          .onConflictDoNothing({
            target: [transactions.accountId, transactions.externalId],
          })
          .returning({
            id: transactions.id,
            externalId: transactions.externalId,
          })
          .all(),
      );
    }
    const inserted = insertedRows.length;
    const duplicateCount = preview.counts.total - inserted;
    if (inserted !== newRows.length) {
      tx.update(imports)
        .set({ newCount: inserted, duplicateCount })
        .where(eq(imports.id, imp.id))
        .run();
    }

    const closing = statement.closingBalance;
    if (closing) {
      tx.insert(balanceSnapshots)
        .values({
          userId,
          accountId,
          importId: imp.id,
          source: "import",
          date: closing.date,
          amount: closing.amount,
        })
        .onConflictDoUpdate({
          target: [
            balanceSnapshots.accountId,
            balanceSnapshots.date,
            balanceSnapshots.source,
          ],
          set: {
            amount: closing.amount,
            importId: imp.id,
            updatedAt: new Date(),
          },
          // An unchanged amount keeps pointing at the import that first wrote it.
          setWhere: sql`${balanceSnapshots.amount} != ${closing.amount}`,
        })
        .run();
    }

    // Real rows take over the mirrors they match, then everything new is linked.
    const idOf = new Map(insertedRows.map((r) => [r.externalId, r.id]));
    let replaced = 0;
    for (const row of newRows) {
      const id = idOf.get(row.tx.externalId);
      if (row.mirrorId === null || id === undefined) continue;
      takeOverMirror(userId, row.mirrorId, id, tx);
      replaced += 1;
    }
    const linked = linkAfterWrite(
      userId,
      accountId,
      insertedRows.map((r) => r.id),
      newRows
        .filter((r) => idOf.has(r.tx.externalId))
        .map((r) => r.tx.bookingDate),
      tx,
    );
    return {
      importId: imp.id,
      accountId,
      newCount: inserted,
      duplicateCount,
      transfers: { ...linked, replaced },
    };
  });

  try {
    deletePending(userId, pendingId);
  } catch (err) {
    // The import is committed; a leftover file is purged when it expires.
    console.error(
      "could not delete pending import %s: %s",
      pendingId,
      describeError(err),
    );
  }
  return result;
}
