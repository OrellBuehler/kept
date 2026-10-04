import { randomUUID } from "node:crypto";
import { minor } from "$lib/money";
import { getDB, imports, transactions } from "$lib/server/db";
import { createAccount, createInstitution } from "$lib/server/ledger";
import type { AccountInput } from "$lib/server/ledger/schemas";

export function seedInstitution(userId: string, name = "Test Institution") {
  return createInstitution(userId, { name, bic: null, color: null });
}

export function seedAccount(userId: string, over: Partial<AccountInput> = {}) {
  return createAccount(userId, {
    institutionId: null,
    name: "Main",
    type: "current",
    currency: "CHF",
    iban: null,
    openingBalance: minor(0),
    openingDate: null,
    shareBps: 10000,
    sharedWith: null,
    sortOrder: null,
    ...over,
  });
}

/** Inserts a row the way the import flow will (source "import"). */
export function seedImportedTransaction(
  userId: string,
  accountId: string,
  over: Partial<typeof transactions.$inferInsert> = {},
) {
  return getDB()
    .insert(transactions)
    .values({
      userId,
      accountId,
      source: "import",
      externalId: `ext-${randomUUID()}`,
      bookingDate: "2024-01-15",
      amount: minor(-1000),
      currency: "CHF",
      ...over,
    })
    .returning()
    .get();
}

export function seedImport(
  userId: string,
  accountId: string,
  over: Partial<typeof imports.$inferInsert> = {},
) {
  return getDB()
    .insert(imports)
    .values({
      userId,
      accountId,
      format: "camt053",
      fileName: "statement.xml",
      fileSha256: randomUUID().replaceAll("-", ""),
      ...over,
    })
    .returning()
    .get();
}
