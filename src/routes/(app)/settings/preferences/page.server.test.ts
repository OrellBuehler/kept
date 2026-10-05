import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "$lib/preferences";
import { getPreferences } from "$lib/server/preferences";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

const valid = {
  ibanDisplay: "masked",
  blurAmounts: "on",
  locale: "de-CH",
  defaultCurrency: "EUR",
  pageSize: "100",
  investmentCashLiquid: "on",
};

describe("settings/preferences", () => {
  useTestDB();

  it("load returns defaults until something is saved", async () => {
    const a = await createTestUser();
    const r = await outcome(() => load(createTestEvent({ user: a }) as never));
    expect(r).toEqual({
      type: "return",
      value: { preferences: DEFAULT_PREFERENCES },
    });
  });

  it("saves every preference for the caller only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const r = await outcome(() =>
      actions.save(createTestEvent({ user: a, form: valid }) as never),
    );
    expect(r).toEqual({ type: "return", value: { success: true } });
    expect(await getPreferences(a.id)).toEqual({
      ibanDisplay: "masked",
      blurAmounts: true,
      locale: "de-CH",
      defaultCurrency: "EUR",
      pageSize: 100,
      investmentCashLiquid: true,
    });
    expect(await getPreferences(b.id)).toEqual(DEFAULT_PREFERENCES);
  });

  it("an unchecked blur switch saves as off", async () => {
    const a = await createTestUser();
    await outcome(() =>
      actions.save(createTestEvent({ user: a, form: valid }) as never),
    );
    const withoutBlur: Record<string, string> = { ...valid };
    delete withoutBlur.blurAmounts;
    await outcome(() =>
      actions.save(createTestEvent({ user: a, form: withoutBlur }) as never),
    );
    expect((await getPreferences(a.id)).blurAmounts).toBe(false);
  });

  it("an unchecked investment cash switch saves as off and setBlur keeps it", async () => {
    const a = await createTestUser();
    await outcome(() =>
      actions.save(createTestEvent({ user: a, form: valid }) as never),
    );
    expect((await getPreferences(a.id)).investmentCashLiquid).toBe(true);
    await outcome(() =>
      actions.setBlur(
        createTestEvent({ user: a, form: { blurAmounts: "false" } }) as never,
      ),
    );
    expect((await getPreferences(a.id)).investmentCashLiquid).toBe(true);
    const without: Record<string, string> = { ...valid };
    delete without.investmentCashLiquid;
    await outcome(() =>
      actions.save(createTestEvent({ user: a, form: without }) as never),
    );
    expect((await getPreferences(a.id)).investmentCashLiquid).toBe(false);
  });

  it("rejects invalid values and stores nothing", async () => {
    const a = await createTestUser();
    const r = await outcome(() =>
      actions.save(
        createTestEvent({
          user: a,
          form: { ...valid, pageSize: "7", locale: "xx" },
        }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
    expect(await getPreferences(a.id)).toEqual(DEFAULT_PREFERENCES);
  });

  it("setBlur only changes the blur preference", async () => {
    const a = await createTestUser();
    await outcome(() =>
      actions.save(createTestEvent({ user: a, form: valid }) as never),
    );
    const r = await outcome(() =>
      actions.setBlur(
        createTestEvent({ user: a, form: { blurAmounts: "false" } }) as never,
      ),
    );
    expect(r).toEqual({ type: "return", value: { success: true } });
    expect(await getPreferences(a.id)).toMatchObject({
      blurAmounts: false,
      locale: "de-CH",
      pageSize: 100,
    });
  });

  it("setBlur rejects a missing or garbage value", async () => {
    const a = await createTestUser();
    const forms: Record<string, string>[] = [
      {},
      { blurAmounts: "maybe" },
      { blurAmounts: "on" },
    ];
    for (const form of forms) {
      const r = await outcome(() =>
        actions.setBlur(createTestEvent({ user: a, form }) as never),
      );
      expect(r).toMatchObject({ type: "fail", status: 400 });
    }
    expect(await getPreferences(a.id)).toEqual(DEFAULT_PREFERENCES);
  });
});
