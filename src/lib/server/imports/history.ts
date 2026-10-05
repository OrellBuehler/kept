import { ledgerLock } from "$lib/server/ledger/lock";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import type { ImportFormat, ImportImpact } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  alias,
  balanceSnapshots,
  billAllocations,
  getDB,
  imports,
  pillar3aContributions,
  transactions,
  transfers,
  first,
  transaction,
} from "$lib/server/db";
import { getAccount } from "$lib/server/ledger/accounts";
import { notFound } from "$lib/server/ledger/errors";
import { linkTransfersInTx } from "$lib/server/transfers/link";

export interface ImportView {
  id: string;
  accountId: string;
  accountName: string;
  currency: string;
  format: ImportFormat;
  fileName: string;
  statementFrom: string | null;
  statementTo: string | null;
  openingBalance: Minor | null;
  openingBalanceDate: string | null;
  closingBalance: Minor | null;
  closingBalanceDate: string | null;
  newCount: number;
  duplicateCount: number;
  warnings: string[];
  createdAt: number;
}

function select() {
  return getDB()
    .select({
      id: imports.id,
      accountId: imports.accountId,
      accountName: accounts.name,
      currency: accounts.currency,
      format: imports.format,
      fileName: imports.fileName,
      statementFrom: imports.statementFrom,
      statementTo: imports.statementTo,
      openingBalance: imports.openingBalance,
      openingBalanceDate: imports.openingBalanceDate,
      closingBalance: imports.closingBalance,
      closingBalanceDate: imports.closingBalanceDate,
      newCount: imports.newCount,
      duplicateCount: imports.duplicateCount,
      warnings: imports.warnings,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId));
}

function toView(row: Awaited<ReturnType<typeof select>>[number]): ImportView {
  let warnings: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.warnings);
    if (Array.isArray(parsed)) {
      warnings = parsed.filter((w): w is string => typeof w === "string");
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.error("import %s has unreadable warnings", row.id);
  }
  return { ...row, warnings, createdAt: row.createdAt.getTime() };
}

/** Imports of one account, newest first. */
export async function listImports(
  userId: string,
  accountId: string,
): Promise<ImportView[]> {
  await getAccount(userId, accountId);
  const rows = await select()
    .where(and(eq(imports.userId, userId), eq(imports.accountId, accountId)))
    .orderBy(desc(imports.createdAt), desc(imports.id));
  return rows.map(toView);
}

/** The latest imports across all of the user's accounts, newest first. */
export async function listRecentImports(
  userId: string,
  limit = 10,
): Promise<ImportView[]> {
  const rows = await select()
    .where(eq(imports.userId, userId))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(limit);
  return rows.map(toView);
}

export type { ImportImpact };

export function hasImportImpact(impact: ImportImpact): boolean {
  return Object.entries(impact).some(
    ([key, n]) => key !== "transactions" && n > 0,
  );
}

const emptyImpact = (): ImportImpact => ({
  transactions: 0,
  categorized: 0,
  notes: 0,
  taxYears: 0,
  deductionYears: 0,
  billAllocations: 0,
  pillar3a: 0,
  transferLinks: 0,
  mirrors: 0,
});

/**
 * What undoing each of the user's imports would touch, in a constant number of grouped
 * queries. Ids that are not the user's own imports are left out of the result.
 */
export async function getImportImpacts(
  userId: string,
  importIds: string[],
): Promise<Map<string, ImportImpact>> {
  const result = new Map<string, ImportImpact>();
  if (importIds.length === 0) return result;
  const db = getDB();
  const owned = await db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.userId, userId), inArray(imports.id, importIds)));
  if (owned.length === 0) return result;
  const ids = owned.map((o) => o.id);
  for (const id of ids) result.set(id, emptyImpact());

  const mine = and(
    eq(transactions.userId, userId),
    inArray(transactions.importId, ids),
  );
  const own = await db
    .select({
      importId: transactions.importId,
      transactions: count(),
      categorized: count(transactions.categoryId),
      notes:
        sql<number>`count(case when trim(coalesce(${transactions.note}, '')) <> '' then 1 end)`.mapWith(
          Number,
        ),
      taxYears: count(transactions.taxYear),
      deductionYears: count(transactions.deductionYear),
    })
    .from(transactions)
    .where(mine)
    .groupBy(transactions.importId);
  for (const { importId, ...rest } of own) {
    Object.assign(result.get(importId!)!, rest);
  }

  const allocations = await db
    .select({
      importId: transactions.importId,
      n: countDistinct(billAllocations.transactionId),
    })
    .from(billAllocations)
    .innerJoin(transactions, eq(transactions.id, billAllocations.transactionId))
    .where(and(eq(billAllocations.userId, userId), mine))
    .groupBy(transactions.importId);
  for (const r of allocations) result.get(r.importId!)!.billAllocations = r.n;

  const contributions = await db
    .select({
      importId: transactions.importId,
      n: countDistinct(pillar3aContributions.transactionId),
    })
    .from(pillar3aContributions)
    .innerJoin(
      transactions,
      eq(transactions.id, pillar3aContributions.transactionId),
    )
    .where(and(eq(pillar3aContributions.userId, userId), mine))
    .groupBy(transactions.importId);
  for (const r of contributions) result.get(r.importId!)!.pillar3a = r.n;

  const links = await db
    .select({ importId: transactions.importId, n: countDistinct(transfers.id) })
    .from(transfers)
    .innerJoin(
      transactions,
      or(
        eq(transactions.id, transfers.outTransactionId),
        eq(transactions.id, transfers.inTransactionId),
      ),
    )
    .where(and(eq(transfers.userId, userId), mine))
    .groupBy(transactions.importId);
  for (const r of links) result.get(r.importId!)!.transferLinks = r.n;

  const mirrorRows = alias(transactions, "mirror_rows");
  const mirrors = await db
    .select({ importId: transactions.importId, n: count() })
    .from(mirrorRows)
    .innerJoin(transactions, eq(transactions.id, mirrorRows.mirrorOfId))
    .where(and(eq(mirrorRows.userId, userId), mine))
    .groupBy(transactions.importId);
  for (const r of mirrors) result.get(r.importId!)!.mirrors = r.n;

  return result;
}

export async function getImportImpact(
  userId: string,
  importId: string,
): Promise<ImportImpact> {
  const impact = (await getImportImpacts(userId, [importId])).get(importId);
  if (!impact) throw notFound("Import");
  return impact;
}

/**
 * Removes an import. Transactions belong to the import that first inserted
 * them (later files that contained them only counted them as duplicates), so
 * undoing that import removes them even if a newer import also covered them.
 * Snapshots still pointing at the import go with it (foreign key cascade);
 * snapshots that a newer import re-pointed to itself stay. When the removed
 * import's closing snapshot disappears, it is restored from the latest
 * remaining import of the account with the same closing date, so balance
 * anchors survive. Bill allocations that reference the removed transactions
 * will cascade as well once bills exist. Mirrors created from the removed
 * rows go with them; mirrors that the removed rows had replaced come back
 * when the account is filled from transfers.
 * `accountId`, when given, must be the import's account.
 */
export async function undoImport(
  userId: string,
  importId: string,
  accountId?: string,
): Promise<{ accountId: string; removedTransactions: number }> {
  return await transaction(
    async (tx) => {
      const found = await first(
        tx
          .select({
            accountId: imports.accountId,
            n: imports.newCount,
            closingDate: imports.closingBalanceDate,
          })
          .from(imports)
          .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
          .limit(1),
      );
      if (
        !found ||
        (accountId !== undefined && found.accountId !== accountId)
      ) {
        throw notFound("Import");
      }
      await tx
        .delete(imports)
        .where(and(eq(imports.id, importId), eq(imports.userId, userId)));

      if (found.closingDate !== null) {
        const present = await first(
          tx
            .select({ id: balanceSnapshots.id })
            .from(balanceSnapshots)
            .where(
              and(
                eq(balanceSnapshots.accountId, found.accountId),
                eq(balanceSnapshots.date, found.closingDate),
                eq(balanceSnapshots.source, "import"),
              ),
            )
            .limit(1),
        );
        if (!present) {
          const heir = await first(
            tx
              .select({ id: imports.id, amount: imports.closingBalance })
              .from(imports)
              .where(
                and(
                  eq(imports.userId, userId),
                  eq(imports.accountId, found.accountId),
                  eq(imports.closingBalanceDate, found.closingDate),
                  isNotNull(imports.closingBalance),
                ),
              )
              .orderBy(desc(imports.createdAt), desc(imports.id))
              .limit(1),
          );
          if (heir && heir.amount !== null) {
            // A snapshot another writer just made is the state we want.
            await tx
              .insert(balanceSnapshots)
              .values({
                userId,
                accountId: found.accountId,
                importId: heir.id,
                source: "import",
                date: found.closingDate,
                amount: heir.amount,
              })
              .onConflictDoNothing();
          }
        }
      }
      // Real rows that had replaced mirrors are gone: the transfers they stood for are mirrored again.
      await linkTransfersInTx(tx, userId, { targetAccountId: found.accountId });
      return { accountId: found.accountId, removedTransactions: found.n };
    },
    { lock: ledgerLock(userId) },
  );
}
