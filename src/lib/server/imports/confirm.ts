import { ledgerLock } from "$lib/server/ledger/lock";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  balanceSnapshots,
  imports,
  transactions,
  first,
  transaction,
} from "$lib/server/db";
import type { CsvMappingProfile } from "$lib/server/importers/mapping";
import { categorize, loadRules } from "$lib/server/categories/rules";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { linkAfterWrite } from "$lib/server/transfers/link";
import { takeOverMirror } from "$lib/server/transfers/replace";
import {
  deletePendingBlob,
  deletePendingRowInTx,
  getPendingMeta,
} from "./pending";
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
export async function confirmImport(
  userId: string,
  pendingId: string,
  options: { profile?: CsvMappingProfile } = {},
): Promise<ConfirmResult> {
  const preview = await buildPreview(userId, pendingId, options);
  if (preview.errors.length > 0) {
    throw new LedgerError("invalid", preview.errors.join(" "));
  }
  const { statement } = preview;
  if (!statement) throw new LedgerError("invalid", "Nothing to import.");

  const sha = (await getPendingMeta(userId, pendingId)).sha256;
  const accountId = preview.account.id;
  const newRows = preview.rows.filter(
    (r) => r.status === "new" || r.status === "replaces_mirror",
  );
  const rules = await loadRules(userId);

  const result = await transaction(
    async (tx) => {
      // Claiming the upload first makes a concurrent second confirm fail and roll back.
      if (!(await deletePendingRowInTx(tx, userId, pendingId))) {
        throw notFound("Upload");
      }
      // Read under the ledger lock, which archiving and deleting the account
      // also take, so neither can commit between this check and the rows below.
      const account = await first(
        tx
          .select({ archived: accounts.archived })
          .from(accounts)
          .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
          .limit(1),
      );
      if (!account) throw notFound("Account");
      if (account.archived) {
        throw new LedgerError(
          "invalid",
          "This account is archived; unarchive it to import into it.",
        );
      }
      const imp = (await first(
        tx
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
          .returning({ id: imports.id }),
      ))!;

      const insertedRows: { id: string; externalId: string }[] = [];
      for (let i = 0; i < newRows.length; i += INSERT_CHUNK) {
        insertedRows.push(
          ...(await tx
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
            })),
        );
      }
      const inserted = insertedRows.length;
      const duplicateCount = preview.counts.total - inserted;
      if (inserted !== newRows.length) {
        await tx
          .update(imports)
          .set({ newCount: inserted, duplicateCount })
          .where(eq(imports.id, imp.id));
      }

      const closing = statement.closingBalance;
      if (closing) {
        await tx
          .insert(balanceSnapshots)
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
          });
      }

      // Real rows take over the mirrors they match, then everything new is linked.
      const idOf = new Map(insertedRows.map((r) => [r.externalId, r.id]));
      let replaced = 0;
      for (const row of newRows) {
        const id = idOf.get(row.tx.externalId);
        if (row.mirrorId === null || id === undefined) continue;
        await takeOverMirror(tx, userId, row.mirrorId, id);
        replaced += 1;
      }
      const linked = await linkAfterWrite(
        tx,
        userId,
        accountId,
        insertedRows.map((r) => r.id),
        newRows
          .filter((r) => idOf.has(r.tx.externalId))
          .map((r) => r.tx.bookingDate),
      );
      return {
        importId: imp.id,
        accountId,
        newCount: inserted,
        duplicateCount,
        transfers: { ...linked, replaced },
      };
    },
    { lock: ledgerLock(userId) },
  );

  try {
    await deletePendingBlob(userId, pendingId);
  } catch (err) {
    // The import is committed; the orphan sweep removes a leftover file.
    console.error(
      "could not delete pending import file %s: %s",
      pendingId,
      describeError(err),
    );
  }
  return result;
}
