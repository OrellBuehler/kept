import { eq } from "drizzle-orm";
import {
  DEFAULT_PREFERENCES,
  preferencesSchema,
  type Preferences,
} from "$lib/preferences";
import { getDB, userPreferences } from "$lib/server/db";

export function getPreferences(userId: string): Preferences {
  const row = getDB()
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .get();
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
  };
}

export function updatePreferences(
  userId: string,
  patch: Partial<Preferences>,
): Preferences {
  const next = { ...getPreferences(userId), ...patch };
  getDB()
    .insert(userPreferences)
    .values({ userId, ...next })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { ...next, updatedAt: new Date() },
    })
    .run();
  return next;
}
