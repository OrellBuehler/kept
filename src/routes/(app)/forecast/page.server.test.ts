import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount } from "$lib/testing/ledger";
import { listAccountSettings, listPlannedItems } from "$lib/server/forecast";
import { actions } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
const run = (
  name: keyof typeof actions,
  user: User,
  form: Record<string, string>,
) => outcome(() => actions[name](createTestEvent({ user, form }) as never));

const planned = (over: Record<string, string> = {}) => ({
  label: "Insurance",
  date: "2026-12-01",
  direction: "expense",
  amount: "120",
  ...over,
});

describe("forecast page actions", () => {
  useTestDB();

  it("creates, updates and deletes a planned item on an account", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id, { currency: "EUR" });
    expect(
      await run("createPlanned", u, planned({ accountId: acc.id })),
    ).toMatchObject({ type: "return", value: { success: true } });
    const [item] = listPlannedItems(u.id);
    expect(item).toMatchObject({
      accountId: acc.id,
      currency: "EUR",
      amount: -12000,
    });

    expect(
      await run(
        "updatePlanned",
        u,
        planned({ id: item!.id, accountId: acc.id, amount: "99" }),
      ),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listPlannedItems(u.id)[0]).toMatchObject({ amount: -9900 });

    expect(await run("deletePlanned", u, { id: item!.id })).toMatchObject({
      type: "return",
      value: { success: true },
    });
    expect(listPlannedItems(u.id)).toEqual([]);
  });

  it("reports an unknown or foreign account as a field error and stores nothing", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id);
    for (const accountId of ["missing", theirs.id]) {
      expect(
        await run("createPlanned", u, planned({ accountId })),
      ).toMatchObject({
        type: "fail",
        status: 400,
        data: {
          action: "createPlanned",
          errors: { accountId: expect.any(Array) },
        },
      });
    }
    expect(listPlannedItems(u.id)).toEqual([]);
    expect(listPlannedItems(other.id)).toEqual([]);
  });

  it("answers 404 for another user's planned item", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    await run("createPlanned", u, planned({ currency: "CHF" }));
    const [item] = listPlannedItems(u.id);
    expect(
      await run("updatePlanned", other, planned({ id: item!.id, amount: "1" })),
    ).toMatchObject({ type: "error", status: 404 });
    expect(await run("deletePlanned", other, { id: item!.id })).toMatchObject({
      type: "error",
      status: 404,
    });
    expect(listPlannedItems(u.id)).toHaveLength(1);
    expect(listPlannedItems(u.id)[0]).toMatchObject({ amount: -12000 });
  });

  it("saves account settings, and answers 404 for another user's account", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = await seedAccount(u.id);
    const theirs = await seedAccount(other.id);
    expect(
      await run("saveSettings", u, {
        accountId: acc.id,
        threshold: "50",
        defaultPayment: "on",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listAccountSettings(u.id)).toEqual([
      { accountId: acc.id, threshold: 5000, defaultPayment: true },
    ]);
    expect(
      await run("saveSettings", u, { accountId: theirs.id, threshold: "1" }),
    ).toMatchObject({ type: "error", status: 404 });
    expect(listAccountSettings(other.id)).toEqual([]);
  });
});
