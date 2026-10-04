import { eq } from "drizzle-orm";
import { getDB, userPreferences } from "$lib/server/db";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { DEFAULT_PREFERENCES, preferencesSchema } from "$lib/preferences";
import { getPreferences, updatePreferences } from "./preferences";

useTestDB();

describe("preferences", () => {
  it("returns defaults when nothing is stored", async () => {
    const u = await createTestUser();
    expect(getPreferences(u.id)).toEqual(DEFAULT_PREFERENCES);
  });

  it("upserts and merges a partial patch over the stored values", async () => {
    const u = await createTestUser();
    updatePreferences(u.id, { blurAmounts: true });
    updatePreferences(u.id, { locale: "de-CH", pageSize: 100 });
    expect(getPreferences(u.id)).toEqual({
      ...DEFAULT_PREFERENCES,
      blurAmounts: true,
      locale: "de-CH",
      pageSize: 100,
    });
  });

  it("stores the investment cash switch and falls back to off", async () => {
    const u = await createTestUser();
    expect(getPreferences(u.id).investmentCashLiquid).toBe(false);
    updatePreferences(u.id, { investmentCashLiquid: true });
    expect(getPreferences(u.id).investmentCashLiquid).toBe(true);
    const other = await createTestUser();
    expect(getPreferences(other.id).investmentCashLiquid).toBe(false);
  });

  it("keeps preferences per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    updatePreferences(a.id, { ibanDisplay: "hidden", defaultCurrency: "EUR" });
    expect(getPreferences(b.id)).toEqual(DEFAULT_PREFERENCES);
    updatePreferences(b.id, { ibanDisplay: "masked" });
    expect(getPreferences(a.id)).toMatchObject({
      ibanDisplay: "hidden",
      defaultCurrency: "EUR",
    });
  });
});

describe("stale stored values", () => {
  it("fall back to defaults per field", async () => {
    const u = await createTestUser();
    updatePreferences(u.id, { blurAmounts: true, locale: "de-CH" });
    getDB()
      .update(userPreferences)
      .set({ defaultCurrency: "XXX", pageSize: 7 })
      .where(eq(userPreferences.userId, u.id))
      .run();
    expect(getPreferences(u.id)).toEqual({
      ...DEFAULT_PREFERENCES,
      blurAmounts: true,
      locale: "de-CH",
    });
  });
});

describe("preferencesSchema", () => {
  const base = {
    ibanDisplay: "masked",
    locale: "de-CH",
    defaultCurrency: "EUR",
    pageSize: "100",
  };

  it("coerces the page size and checkbox strings", () => {
    expect(preferencesSchema.parse({ ...base, blurAmounts: "on" })).toEqual({
      ibanDisplay: "masked",
      blurAmounts: true,
      locale: "de-CH",
      defaultCurrency: "EUR",
      pageSize: 100,
      investmentCashLiquid: false,
    });
    expect(
      preferencesSchema.parse({ ...base, blurAmounts: "true" }).blurAmounts,
    ).toBe(true);
    expect(
      preferencesSchema.parse({ ...base, blurAmounts: "false" }).blurAmounts,
    ).toBe(false);
    expect(preferencesSchema.parse(base).blurAmounts).toBe(false);
    expect(
      preferencesSchema.parse({ ...base, investmentCashLiquid: "on" })
        .investmentCashLiquid,
    ).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(
      preferencesSchema.safeParse({ ...base, pageSize: "30" }).success,
    ).toBe(false);
    expect(preferencesSchema.safeParse({ ...base, locale: "xx" }).success).toBe(
      false,
    );
    expect(
      preferencesSchema.safeParse({ ...base, defaultCurrency: "JPY" }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({ ...base, ibanDisplay: "x" }).success,
    ).toBe(false);
  });
});
