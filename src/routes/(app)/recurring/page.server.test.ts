import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
const run = (
  name: keyof typeof actions,
  user: User,
  form: Record<string, string>,
) => outcome(() => actions[name](createTestEvent({ user, form }) as never));

async function withSeries() {
  const user = await createTestUser();
  const account = seedAccount(user.id);
  for (const month of ["01", "02", "03"]) {
    seedImportedTransaction(user.id, account.id, {
      bookingDate: `2026-${month}-05`,
      amount: minor(-1290),
      counterpartyName: "Example Streaming",
    });
  }
  return user;
}

const loadFor = async (user: User) =>
  (
    (await outcome(() => load(createTestEvent({ user }) as never))) as {
      value: {
        series: { id: string; status: string; name: string }[];
        totals: { currency: string; outflowAnnual: number }[];
      };
    }
  ).value;

describe("recurring page", () => {
  useTestDB();

  it("load detects series for the current user only", async () => {
    const a = await withSeries();
    const b = await createTestUser();
    const v = await loadFor(a);
    expect(v.series).toMatchObject([
      { name: "Example Streaming", status: "suggested" },
    ]);
    expect(v.totals).toEqual([]);
    expect((await loadFor(b)).series).toEqual([]);
  });

  it("confirms, edits, dismisses and restores", async () => {
    const u = await withSeries();
    const [s] = (await loadFor(u)).series;
    expect(await run("confirm", u, { id: s!.id })).toMatchObject({
      type: "return",
      value: { success: true },
    });
    expect((await loadFor(u)).totals).toMatchObject([
      { currency: "CHF", outflowAnnual: 15480 },
    ]);
    await run("edit", u, {
      id: s!.id,
      name: "Streaming",
      cadence: "yearly",
      amount: "100",
    });
    expect((await loadFor(u)).series[0]).toMatchObject({ name: "Streaming" });
    await run("dismiss", u, { id: s!.id });
    expect((await loadFor(u)).series[0]?.status).toBe("dismissed");
    await run("restore", u, { id: s!.id });
    expect((await loadFor(u)).series[0]?.status).toBe("suggested");
  });

  it("rejects invalid input and foreign ids", async () => {
    const u = await withSeries();
    const other = await createTestUser();
    const [s] = (await loadFor(u)).series;
    expect(
      await run("edit", u, {
        id: s!.id,
        name: "",
        cadence: "daily",
        amount: "1",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(
      await run("edit", u, {
        id: s!.id,
        name: "x",
        cadence: "weekly",
        amount: "abc",
      }),
    ).toMatchObject({ type: "fail", status: 400 });
    expect(await run("confirm", other, { id: s!.id })).toMatchObject({
      type: "error",
      status: 404,
    });
  });
});
