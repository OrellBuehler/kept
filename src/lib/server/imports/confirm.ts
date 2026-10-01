import { eq, sql } from "drizzle-orm";
import { balanceSnapshots, getDB, imports, transactions } from "$lib/server/db";
import type { CsvMappingProfile } from "$lib/server/importers/mapping";
import { categorize, loadRules } from "$lib/server/categories/rules";
import { getAccount } from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { deletePending, getPendingMeta } from "./pending";
import { buildPreview } from "./preview";

export interface ConfirmResult {
  importId: string;
  accountId: string;
  newCount: number;
  duplicateCount: number;
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
  const newRows = preview.rows.filter((r) => r.status === "new");
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
        warnings: JSON.stringify(preview.warnings),
      })
      .returning({ id: imports.id })
      .get();

    let inserted = 0;
    for (let i = 0; i < newRows.length; i += INSERT_CHUNK) {
      inserted += tx
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
        .returning({ id: transactions.id })
        .all().length;
    }
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
    return { importId: imp.id, accountId, newCount: inserted, duplicateCount };
  });

  try {
    deletePending(userId, pendingId);
  } catch (err) {
    // The import is committed; a leftover file is purged when it expires.
    console.error(
      "could not delete pending import %s: %s",
      pendingId,
      err instanceof Error ? err.name : "error",
    );
  }
  return result;
}
