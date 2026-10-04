import { and, eq, inArray, ne } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import { accounts, forecastAccountSettings, getDB } from "$lib/server/db";
import { getAccount } from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import type { AccountSettingsInput } from "./schemas";

export interface AccountSettings {
  accountId: string;
  threshold: Minor | null;
  defaultPayment: boolean;
}

export function listAccountSettings(userId: string): AccountSettings[] {
  return getDB()
    .select({
      accountId: forecastAccountSettings.accountId,
      threshold: forecastAccountSettings.threshold,
      defaultPayment: forecastAccountSettings.isDefaultPayment,
    })
    .from(forecastAccountSettings)
    .where(eq(forecastAccountSettings.userId, userId))
    .all();
}

export async function saveAccountSettings(
  userId: string,
  input: AccountSettingsInput,
): Promise<void> {
  const account = await getAccount(userId, input.accountId);
  let threshold: Minor | null = null;
  const text = input.threshold ?? "";
  if (text !== "") {
    const parsed = parseMoneyInput(text, account.currency);
    if (!parsed.ok) {
      throw new LedgerError("invalid", parsed.message, "threshold");
    }
    threshold = minor(parsed.value);
  }
  const defaultPayment =
    input.defaultPayment === "on" || input.defaultPayment === "true";
  const db = getDB();
  db.transaction((tx) => {
    tx.insert(forecastAccountSettings)
      .values({
        userId,
        accountId: account.id,
        threshold,
        isDefaultPayment: defaultPayment,
      })
      .onConflictDoUpdate({
        target: forecastAccountSettings.accountId,
        set: { threshold, isDefaultPayment: defaultPayment },
      })
      .run();
    if (defaultPayment) {
      const sameCurrency = tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.currency, account.currency),
            ne(accounts.id, account.id),
          ),
        )
        .all()
        .map((a) => a.id);
      if (sameCurrency.length > 0) {
        tx.update(forecastAccountSettings)
          .set({ isDefaultPayment: false })
          .where(
            and(
              eq(forecastAccountSettings.userId, userId),
              inArray(forecastAccountSettings.accountId, sameCurrency),
            ),
          )
          .run();
      }
    }
  });
}
