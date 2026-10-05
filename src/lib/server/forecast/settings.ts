import { and, eq, inArray, ne } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import { accounts, forecastAccountSettings, getDB } from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { parseMoneyInput } from "$lib/server/ledger/schemas";
import type { AccountSettingsInput } from "./schemas";

export interface AccountSettings {
  accountId: string;
  threshold: Minor | null;
  defaultPayment: boolean;
}

export async function listAccountSettings(
  userId: string,
): Promise<AccountSettings[]> {
  return await getDB()
    .select({
      accountId: forecastAccountSettings.accountId,
      threshold: forecastAccountSettings.threshold,
      defaultPayment: forecastAccountSettings.isDefaultPayment,
    })
    .from(forecastAccountSettings)
    .where(eq(forecastAccountSettings.userId, userId));
}

export async function saveAccountSettings(
  userId: string,
  input: AccountSettingsInput,
): Promise<void> {
  const defaultPayment =
    input.defaultPayment === "on" || input.defaultPayment === "true";
  // The account is read in the same transaction as the writes, so its
  // currency cannot change or the account vanish between the check and them.
  getDB().transaction((tx) => {
    const account = tx
      .select({ id: accounts.id, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, input.accountId)))
      .limit(1)
      .get();
    if (!account) throw notFound("Account");
    let threshold: Minor | null = null;
    const text = input.threshold ?? "";
    if (text !== "") {
      const parsed = parseMoneyInput(text, account.currency);
      if (!parsed.ok) {
        throw new LedgerError("invalid", parsed.message, "threshold");
      }
      threshold = minor(parsed.value);
    }
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
