import { eq } from "drizzle-orm";
import {
  DEFAULT_PREFERENCES,
  preferencesSchema,
  type Preferences,
} from "$lib/preferences";
import { first, getDB, userPreferences, transaction } from "$lib/server/db";

type PreferencesRow = typeof userPreferences.$inferSelect;

export async function getPreferences(userId: string): Promise<Preferences> {
  const row = await first(
    getDB()
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1),
  );
  return toPreferences(row);
}

function toPreferences(row: PreferencesRow | undefined): Preferences {
  if (!row) return { ...DEFAULT_PREFERENCES };
  // Stored values can go stale (e.g. a removed locale); fall back per field.
  const shape = preferencesSchema.shape;
  const pick = <K extends keyof Preferences>(
    key: K,
    stored: unknown,
  ): Preferences[K] => {
    const parsed = shape[key].safeParse(stored);
    return parsed.success
      ? (parsed.data as Preferences[K])
      : DEFAULT_PREFERENCES[key];
  };
  return {
    ibanDisplay: pick("ibanDisplay", row.ibanDisplay),
    blurAmounts: pick("blurAmounts", row.blurAmounts),
    locale: pick("locale", row.locale),
    defaultCurrency: pick("defaultCurrency", row.defaultCurrency),
    pageSize: pick("pageSize", row.pageSize),
    investmentCashLiquid: pick(
      "investmentCashLiquid",
      row.investmentCashLiquid,
    ),
  };
}

/** Read, merge and write in one transaction, so concurrent patches of different fields both survive. */
export async function updatePreferences(
  userId: string,
  patch: Partial<Preferences>,
): Promise<Preferences> {
  return await transaction(async (tx) => {
    const row = await first(
      tx
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1),
    );
    const next = { ...toPreferences(row), ...patch };
    await tx
      .insert(userPreferences)
      .values({ userId, ...next })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...next, updatedAt: new Date() },
      });
    return next;
  });
}
