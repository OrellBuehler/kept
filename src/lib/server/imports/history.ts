import { and, desc, eq } from "drizzle-orm";
import type { ImportFormat } from "$lib/ledger-types";
import type { Minor } from "$lib/money";
import { accounts, getDB, imports } from "$lib/server/db";
import { getAccount } from "$lib/server/ledger/accounts";
import { notFound } from "$lib/server/ledger/errors";

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

/**
 * Removes an import. Its transactions and the balance snapshots still
 * pointing at it go with it (foreign key cascade). Snapshots that a newer
 * import re-pointed to itself stay. Bill allocations that reference the
 * removed transactions will cascade as well once bills exist.
 * `accountId`, when given, must be the import's account.
 */
export function undoImport(
  userId: string,
  importId: string,
  accountId?: string,
): { accountId: string; removedTransactions: number } {
  const found = getDB()
    .select({
      id: imports.id,
      accountId: imports.accountId,
      n: imports.newCount,
    })
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
    .get();
  if (!found || (accountId !== undefined && found.accountId !== accountId)) {
    throw notFound("Import");
  }
  getDB()
    .delete(imports)
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
    .run();
  return { accountId: found.accountId, removedTransactions: found.n };
}
