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
import { alias } from "drizzle-orm/sqlite-core";
import type { ImportFormat, ImportImpact } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import {
  accounts,
  balanceSnapshots,
  billAllocations,
  getDB,
  imports,
  pillar3aContributions,
  transactions,
  transfers,
} from "$lib/server/db";
import { getAccount } from "$lib/server/ledger/accounts";
import { notFound } from "$lib/server/ledger/errors";
import { linkTransfers } from "$lib/server/transfers/link";

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

function toView(
  row: ReturnType<ReturnType<typeof select>["all"]>[number],
): ImportView {
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
export function listImports(userId: string, accountId: string): ImportView[] {
  getAccount(userId, accountId);
  return select()
    .where(and(eq(imports.userId, userId), eq(imports.accountId, accountId)))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .all()
    .map(toView);
}

/** The latest imports across all of the user's accounts, newest first. */
export function listRecentImports(userId: string, limit = 10): ImportView[] {
  return select()
    .where(eq(imports.userId, userId))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(limit)
    .all()
    .map(toView);
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
export function getImportImpacts(
  userId: string,
  importIds: string[],
): Map<string, ImportImpact> {
  const result = new Map<string, ImportImpact>();
  if (importIds.length === 0) return result;
  const db = getDB();
  const owned = db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.userId, userId), inArray(imports.id, importIds)))
    .all();
  if (owned.length === 0) return result;
  const ids = owned.map((o) => o.id);
  for (const id of ids) result.set(id, emptyImpact());

  const mine = and(
    eq(transactions.userId, userId),
    inArray(transactions.importId, ids),
  );
  const own = db
    .select({
      importId: transactions.importId,
      transactions: count(),
      categorized: count(transactions.categoryId),
      notes: sql<number>`count(case when trim(coalesce(${transactions.note}, '')) <> '' then 1 end)`,
      taxYears: count(transactions.taxYear),
      deductionYears: count(transactions.deductionYear),
    })
    .from(transactions)
    .where(mine)
    .groupBy(transactions.importId)
    .all();
  for (const { importId, ...rest } of own) {
    Object.assign(result.get(importId!)!, rest);
  }

  const allocations = db
    .select({
      importId: transactions.importId,
      n: countDistinct(billAllocations.transactionId),
    })
    .from(billAllocations)
    .innerJoin(transactions, eq(transactions.id, billAllocations.transactionId))
    .where(and(eq(billAllocations.userId, userId), mine))
    .groupBy(transactions.importId)
    .all();
  for (const r of allocations) result.get(r.importId!)!.billAllocations = r.n;

  const contributions = db
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
    .groupBy(transactions.importId)
    .all();
  for (const r of contributions) result.get(r.importId!)!.pillar3a = r.n;

  const links = db
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
    .groupBy(transactions.importId)
    .all();
  for (const r of links) result.get(r.importId!)!.transferLinks = r.n;

  const mirrorRows = alias(transactions, "mirror_rows");
  const mirrors = db
    .select({ importId: transactions.importId, n: count() })
    .from(mirrorRows)
    .innerJoin(transactions, eq(transactions.id, mirrorRows.mirrorOfId))
    .where(and(eq(mirrorRows.userId, userId), mine))
    .groupBy(transactions.importId)
    .all();
  for (const r of mirrors) result.get(r.importId!)!.mirrors = r.n;

  return result;
}

export function getImportImpact(
  userId: string,
  importId: string,
): ImportImpact {
  const impact = getImportImpacts(userId, [importId]).get(importId);
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
export function undoImport(
  userId: string,
  importId: string,
  accountId?: string,
): { accountId: string; removedTransactions: number } {
  return getDB().transaction((tx) => {
    const found = tx
      .select({
        accountId: imports.accountId,
        n: imports.newCount,
        closingDate: imports.closingBalanceDate,
      })
      .from(imports)
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
      .get();
    if (!found || (accountId !== undefined && found.accountId !== accountId)) {
      throw notFound("Import");
    }
    tx.delete(imports)
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
      .run();

    if (found.closingDate !== null) {
      const present = tx
        .select({ id: balanceSnapshots.id })
        .from(balanceSnapshots)
        .where(
          and(
            eq(balanceSnapshots.accountId, found.accountId),
            eq(balanceSnapshots.date, found.closingDate),
            eq(balanceSnapshots.source, "import"),
          ),
        )
        .get();
      if (!present) {
        const heir = tx
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
          .get();
        if (heir && heir.amount !== null) {
          tx.insert(balanceSnapshots)
            .values({
              userId,
              accountId: found.accountId,
              importId: heir.id,
              source: "import",
              date: found.closingDate,
              amount: heir.amount,
            })
            .run();
        }
      }
    }
    // Real rows that had replaced mirrors are gone: the transfers they stood for are mirrored again.
    linkTransfers(userId, { targetAccountId: found.accountId }, tx);
    return { accountId: found.accountId, removedTransactions: found.n };
  });
}
