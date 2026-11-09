import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { minor } from "$lib/money";
import { getDB, imports, transactions } from "$lib/server/db";
import {
  archiveAccount,
  createAccount,
  createInstitution,
} from "$lib/server/ledger";
import type { AccountInput } from "$lib/server/ledger/schemas";

export async function seedInstitution(
  userId: string,
  name = "Test Institution",
) {
  return await createInstitution(userId, { name, bic: null, color: null });
}

export async function seedAccount(
  userId: string,
  over: Partial<AccountInput> = {},
) {
  return await createAccount(userId, {
    institutionId: null,
    name: "Main",
    type: "current",
    currency: "CHF",
    iban: null,
    contractNumber: null,
    depositIban: null,
    openingBalance: minor(0),
    openingDate: null,
    noticeMonths: null,
    freeWithdrawal: null,
    freeWithdrawalPeriod: null,
    shareBps: 10000,
    sharedWith: null,
    sortOrder: null,
    fillFromTransfers: false,
    tradesMoveCash: false,
    ...over,
  });
}

/** Inserts a row the way the import flow will (source "import"). */
export async function seedImportedTransaction(
  userId: string,
  accountId: string,
  over: Partial<typeof transactions.$inferInsert> = {},
) {
  return (
    await getDB()
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
  )[0]!;
}

export async function seedImport(
  userId: string,
  accountId: string,
  over: Partial<typeof imports.$inferInsert> = {},
) {
  return (
    await getDB()
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
  )[0]!;
}

export async function archiveAccountOn(
  userId: string,
  accountId: string,
  date: string,
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(`${date}T12:00:00.000Z`));
    await archiveAccount(userId, accountId);
  } finally {
    vi.useRealTimers();
  }
}
