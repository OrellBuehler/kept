import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { afterCommit, getDB, transaction, transactions } from "$lib/server/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import * as detect from "./detect";
import {
  confirmSeries,
  dismissSeries,
  editSeries,
  listRecurring,
  projectRecurring,
  recurringTotals,
  restoreSeries,
  syncRecurring,
} from "./series";

useTestDB();

async function setup() {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const eur = await seedAccount(user.id, { name: "Euro", currency: "EUR" });
  const pay = async (
    bookingDate: string,
    amount: number,
    counterpartyName: string,
    over: { currency?: string; reversal?: boolean } = {},
  ) =>
    await seedImportedTransaction(
      user.id,
      over.currency === "EUR" ? eur.id : account.id,
      {
        bookingDate,
        amount: minor(amount),
        currency: over.currency ?? "CHF",
        counterpartyName,
        reversal: over.reversal ?? false,
      },
    );
  const months = async (
    name: string,
    amounts: number[],
    day = "05",
    over: { currency?: string } = {},
  ) => {
    for (const [i, a] of amounts.entries()) {
      await pay(`2026-${String(i + 1).padStart(2, "0")}-${day}`, a, name, over);
    }
  };
  return { user, account, pay, months };
}

describe("syncRecurring", () => {
  it("stores detected series as suggestions", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    await syncRecurring(user.id);
    const list = await listRecurring(user.id, "2026-04-01");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: "suggested",
      name: "Example Streaming",
      cadence: "monthly",
      amount: -1290,
      annualCost: -15480,
      monthlyCost: -1290,
      lastDate: "2026-03-05",
      nextExpected: "2026-04-05",
      overdue: false,
      priceChange: null,
    });
  });

  it("is idempotent", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    await syncRecurring(user.id);
    await syncRecurring(user.id);
    expect(await listRecurring(user.id)).toHaveLength(1);
  });

  it("survives two overlapping runs without duplicating a series", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    await Promise.all([syncRecurring(user.id), syncRecurring(user.id)]);
    expect(await listRecurring(user.id)).toHaveLength(1);
  });

  it("detects outside any transaction, so the database stays free meanwhile", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    const real = detect.detectSeries;
    let insideTransaction: boolean | null = null;
    const spy = vi.spyOn(detect, "detectSeries").mockImplementation((rows) => {
      // afterCommit runs at once outside a transaction and is deferred inside one.
      let ran = false;
      afterCommit(() => {
        ran = true;
      });
      insideTransaction = !ran;
      return real(rows);
    });
    await syncRecurring(user.id);
    spy.mockRestore();
    expect(insideTransaction).toBe(false);
    expect(await listRecurring(user.id)).toHaveLength(1);
  });

  it("detects again when the transactions changed while it was detecting", async () => {
    const { user, account, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    const real = detect.detectSeries;
    let calls = 0;
    let late: Promise<unknown> = Promise.resolve();
    const spy = vi.spyOn(detect, "detectSeries").mockImplementation((rows) => {
      const detected = real(rows);
      if (++calls === 1) {
        // A write lands after detection read its rows, before the result is applied.
        late = getDB()
          .insert(transactions)
          .values({
            userId: user.id,
            accountId: account.id,
            source: "manual",
            externalId: "late",
            bookingDate: "2026-04-05",
            amount: minor(-1290),
            currency: "CHF",
            counterpartyName: "Example Streaming",
            reversal: false,
          })
          .then(() => undefined);
      }
      return detected;
    });
    await syncRecurring(user.id);
    spy.mockRestore();
    await late;
    expect(calls).toBe(2);
    const [series] = await listRecurring(user.id);
    expect(series).toMatchObject({ lastDate: "2026-04-05", occurrences: 4 });
  });

  describe("when the source rows change between detection and applying", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /**
     * Runs `change(n)` in its own transaction right after the n-th detection
     * outside the sync's transaction (n starting at 1). It is queued on the
     * gate before the sync's own transaction asks for it, so it commits first.
     */
    function changeAfterDetection(
      times: number,
      change: (n: number) => Promise<void>,
    ) {
      const real = detect.detectSeries;
      const pending: Promise<void>[] = [];
      let calls = 0;
      const spy = vi
        .spyOn(detect, "detectSeries")
        .mockImplementation((rows) => {
          const detected = real(rows);
          if (++calls <= times) {
            const n = calls;
            pending.push(transaction(() => change(n)));
          }
          return detected;
        });
      return {
        get calls() {
          return calls;
        },
        async done() {
          spy.mockRestore();
          await Promise.all(pending);
        },
      };
    }

    it("notices an edited transaction", async () => {
      const { user, pay, months } = await setup();
      await months("Example Streaming", [-1290, -1290, -1290]);
      const last = await pay("2026-04-05", -1290, "Example Streaming");
      await sleep(5);
      const probe = changeAfterDetection(1, async () => {
        await getDB()
          .update(transactions)
          .set({ amount: minor(-1490) })
          .where(eq(transactions.id, last.id));
      });
      await syncRecurring(user.id);
      await probe.done();
      expect(probe.calls).toBe(2);
      const [series] = await listRecurring(user.id);
      expect(series?.lastAmount).toBe(-1490);
    });

    it("notices a deleted transaction", async () => {
      const { user, pay, months } = await setup();
      await months("Example Streaming", [-1290, -1290, -1290]);
      const last = await pay("2026-04-05", -1290, "Example Streaming");
      const probe = changeAfterDetection(1, async () => {
        await getDB().delete(transactions).where(eq(transactions.id, last.id));
      });
      await syncRecurring(user.id);
      await probe.done();
      expect(probe.calls).toBe(2);
      const [series] = await listRecurring(user.id);
      expect(series).toMatchObject({ lastDate: "2026-03-05", occurrences: 3 });
    });

    it("notices one transaction replaced by another with the same timestamp", async () => {
      const { user, account, pay, months } = await setup();
      await months("Example Streaming", [-1290, -1290, -1290]);
      const last = await pay("2026-04-05", -1290, "Example Streaming");
      const stamp = new Date("2026-04-06T10:00:00.000Z");
      await getDB()
        .update(transactions)
        .set({ updatedAt: stamp })
        .where(eq(transactions.id, last.id));
      const probe = changeAfterDetection(1, async () => {
        await getDB().delete(transactions).where(eq(transactions.id, last.id));
        await getDB()
          .insert(transactions)
          .values({
            userId: user.id,
            accountId: account.id,
            source: "manual",
            externalId: "replacement",
            updatedAt: stamp,
            bookingDate: "2026-04-06",
            amount: minor(-1290),
            currency: "CHF",
            counterpartyName: "Example Streaming",
            reversal: false,
          });
      });
      await syncRecurring(user.id);
      await probe.done();
      expect(probe.calls).toBe(2);
      const [series] = await listRecurring(user.id);
      expect(series).toMatchObject({ lastDate: "2026-04-06", occurrences: 4 });
    });

    it("applies fresh results, not stale ones, when every attempt is outdated", async () => {
      const { user, account, months } = await setup();
      await months("Example Streaming", [-1290, -1290, -1290]);
      const probe = changeAfterDetection(3, async (n) => {
        await getDB()
          .insert(transactions)
          .values({
            userId: user.id,
            accountId: account.id,
            source: "manual",
            externalId: `late-${n}`,
            bookingDate: `2026-0${3 + n}-05`,
            amount: minor(-1290),
            currency: "CHF",
            counterpartyName: "Example Streaming",
            reversal: false,
          });
      });
      await syncRecurring(user.id);
      await probe.done();
      // Three outdated attempts, then one more detection inside the transaction.
      expect(probe.calls).toBe(4);
      const [series] = await listRecurring(user.id);
      expect(series).toMatchObject({ lastDate: "2026-06-05", occurrences: 6 });
    });
  });

  it("flags a price change and an overdue payment", async () => {
    const { user, months } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290, -1490]);
    await syncRecurring(user.id);
    const [s] = await listRecurring(user.id, "2026-05-20");
    expect(s?.priceChange).toEqual({
      previous: -1290,
      latest: -1490,
      delta: -200,
    });
    expect(s?.amount).toBe(-1490);
    expect(s?.overdue).toBe(true);
  });

  it("keeps a dismissal when detection runs again", async () => {
    const { user, months, pay } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    await syncRecurring(user.id);
    const [s] = await listRecurring(user.id);
    await dismissSeries(user.id, s!.id);
    await pay("2026-04-05", -1290, "Example Streaming");
    await syncRecurring(user.id);
    const after = await listRecurring(user.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      status: "dismissed",
      lastDate: "2026-04-05",
    });
    await restoreSeries(user.id, s!.id);
    expect((await listRecurring(user.id))[0]?.status).toBe("suggested");
  });

  it("keeps edits and refreshes statistics around them", async () => {
    const { user, months, pay } = await setup();
    await months("Example Streaming", [-1290, -1290, -1290]);
    await syncRecurring(user.id);
    const [s] = await listRecurring(user.id);
    await confirmSeries(user.id, s!.id);
    await editSeries(user.id, s!.id, {
      name: "Streaming",
      cadence: "monthly",
      amount: "13.00",
    });
    await pay("2026-04-05", -1490, "Example Streaming");
    await syncRecurring(user.id);
    expect((await listRecurring(user.id))[0]).toMatchObject({
      status: "confirmed",
      name: "Streaming",
      amount: -1300,
      lastAmount: -1490,
      lastDate: "2026-04-05",
    });
  });

  it("drops suggestions that no longer hold but keeps confirmed series", async () => {
    const { user, months } = await setup();
    await months("Gym", [-5000, -5000, -5000]);
    await months("Insurance", [-9000, -9000, -9000], "10");
    await syncRecurring(user.id);
    const insurance = (await listRecurring(user.id)).find(
      (s) => s.name === "Insurance",
    )!;
    await confirmSeries(user.id, insurance.id);
    // Re-importing never removes rows here, so simulate by wiping the user's transactions.
    const { getDB, transactions } = await import("$lib/server/db");
    await getDB().delete(transactions);
    await syncRecurring(user.id);
    expect((await listRecurring(user.id)).map((s) => s.name)).toEqual([
      "Insurance",
    ]);
  });

  it("ignores refunded charges", async () => {
    const { user, pay } = await setup();
    await pay("2026-01-05", -1290, "Example Streaming");
    await pay("2026-02-05", -1290, "Example Streaming");
    await pay("2026-02-10", 1290, "Example Streaming");
    await pay("2026-03-05", -1290, "Example Streaming");
    await pay("2026-04-05", -1290, "Example Streaming");
    await syncRecurring(user.id);
    expect((await listRecurring(user.id))[0]?.occurrences).toBe(3);
  });

  it("never touches another user's data", async () => {
    const a = await setup();
    const b = await setup();
    await a.months("Example Streaming", [-1290, -1290, -1290]);
    await syncRecurring(b.user.id);
    expect(await listRecurring(b.user.id)).toEqual([]);
    await syncRecurring(a.user.id);
    const [s] = await listRecurring(a.user.id);
    await expect(confirmSeries(b.user.id, s!.id)).rejects.toThrow("not found");
    await expect(dismissSeries(b.user.id, s!.id)).rejects.toThrow("not found");
    await expect(
      editSeries(b.user.id, s!.id, {
        name: "x",
        cadence: "weekly",
        amount: "1",
      }),
    ).rejects.toThrow("not found");
    expect(
      await projectRecurring(b.user.id, "2026-01-01", "2026-12-31"),
    ).toEqual([]);
  });
});

describe("editSeries", () => {
  it("keeps the direction and rejects bad amounts", async () => {
    const { user, months } = await setup();
    await months("Employer", [500000, 500000, 500000], "25");
    await syncRecurring(user.id);
    const [s] = await listRecurring(user.id);
    await editSeries(user.id, s!.id, {
      name: "Employer",
      cadence: "monthly",
      amount: "5'100.00",
    });
    expect((await listRecurring(user.id))[0]?.amount).toBe(510000);
    await expect(
      editSeries(user.id, s!.id, {
        name: "Employer",
        cadence: "monthly",
        amount: "abc",
      }),
    ).rejects.toThrow();
    await expect(
      editSeries(user.id, s!.id, {
        name: "Employer",
        cadence: "monthly",
        amount: "0",
      }),
    ).rejects.toThrow("zero");
  });
});

describe("recurringTotals", () => {
  it("sums confirmed series per currency without converting", async () => {
    const { user, months } = await setup();
    await months("Streaming", [-1000, -1000, -1000]);
    await months("Cloud", [-200, -200, -200], "07", { currency: "EUR" });
    await months("Employer", [400000, 400000, 400000], "25");
    await months("Pending", [-777, -777, -777], "12");
    await syncRecurring(user.id);
    for (const s of await listRecurring(user.id)) {
      if (s.name !== "Pending") await confirmSeries(user.id, s.id);
    }
    expect(recurringTotals(await listRecurring(user.id))).toEqual([
      {
        currency: "CHF",
        outflowMonthly: 1000,
        outflowAnnual: 12000,
        inflowMonthly: 400000,
        inflowAnnual: 4800000,
      },
      {
        currency: "EUR",
        outflowMonthly: 200,
        outflowAnnual: 2400,
        inflowMonthly: 0,
        inflowAnnual: 0,
      },
    ]);
  });
});

describe("projectRecurring", () => {
  it("projects confirmed series after their last payment, sorted by date", async () => {
    const { user, months, pay } = await setup();
    await months("Streaming", [-1000, -1000, -1000]);
    await months("Rent", [-150000, -150000, -150000], "01");
    await pay("2026-01-15", -8000, "Insurer");
    await pay("2026-04-15", -8000, "Insurer");
    await pay("2026-07-15", -8000, "Insurer");
    await syncRecurring(user.id);
    for (const s of await listRecurring(user.id))
      await confirmSeries(user.id, s.id);

    const out = await projectRecurring(user.id, "2026-04-01", "2026-05-31");
    expect(
      out.map((o) => [o.date, o.name, o.amount, o.currency, o.cadence]),
    ).toEqual([
      ["2026-04-01", "Rent", -150000, "CHF", "monthly"],
      ["2026-04-05", "Streaming", -1000, "CHF", "monthly"],
      ["2026-05-01", "Rent", -150000, "CHF", "monthly"],
      ["2026-05-05", "Streaming", -1000, "CHF", "monthly"],
    ]);
    const wide = await projectRecurring(user.id, "2026-08-01", "2026-12-31");
    expect(wide.filter((o) => o.name === "Insurer").map((o) => o.date)).toEqual(
      ["2026-10-15"],
    );
  });

  it("skips suggested and dismissed series and includes both bounds", async () => {
    const { user, months } = await setup();
    await months("Streaming", [-1000, -1000, -1000]);
    await months("Gym", [-5000, -5000, -5000], "10");
    await months("Cloud", [-200, -200, -200], "07");
    await syncRecurring(user.id);
    for (const s of await listRecurring(user.id)) {
      if (s.name === "Streaming") await confirmSeries(user.id, s.id);
      if (s.name === "Gym") await dismissSeries(user.id, s.id);
    }
    const out = await projectRecurring(user.id, "2026-04-05", "2026-04-05");
    expect(out.map((o) => o.name)).toEqual(["Streaming"]);
  });

  it("projects income as positive and keeps currencies apart", async () => {
    const { user, months } = await setup();
    await months("Employer", [400000, 400000, 400000], "25");
    await months("Cloud", [-200, -200, -200], "07", { currency: "EUR" });
    await syncRecurring(user.id);
    for (const s of await listRecurring(user.id))
      await confirmSeries(user.id, s.id);
    const out = await projectRecurring(user.id, "2026-04-01", "2026-04-30");
    expect(out.map((o) => [o.name, o.amount, o.currency])).toEqual([
      ["Cloud", -200, "EUR"],
      ["Employer", 400000, "CHF"],
    ]);
  });

  it("starts from the latest amount after a price change", async () => {
    const { user, months } = await setup();
    await months("Streaming", [-1000, -1000, -1000, -1200]);
    await syncRecurring(user.id);
    await confirmSeries(user.id, (await listRecurring(user.id))[0]!.id);
    const [o] = await projectRecurring(user.id, "2026-05-01", "2026-05-31");
    expect(o?.amount).toBe(-1200);
  });

  it("returns nothing for an empty or inverted range and rejects bad dates", async () => {
    const { user } = await setup();
    expect(await projectRecurring(user.id, "2026-05-01", "2026-04-01")).toEqual(
      [],
    );
    await expect(
      projectRecurring(user.id, "2026-13-01", "2026-14-01"),
    ).rejects.toThrow();
  });
});
