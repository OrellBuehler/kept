import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { localToday } from "$lib/server/ledger";
import {
  listContributions,
  listYearSettings,
  pillar3aOverview,
} from "$lib/server/pillar3a";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { actions, load } from "./+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;
type LoadData = Exclude<Awaited<ReturnType<typeof load>>, void>;

const run = (
  name: keyof typeof actions,
  user: User,
  form: Record<string, string> = {},
) => outcome(() => actions[name]!(createTestEvent({ user, form }) as never));
const loadAs = async (user: User) =>
  (
    (await outcome(() => load(createTestEvent({ user }) as never))) as {
      value: LoadData;
    }
  ).value;

// Credit dates in the running year, so the tests do not depend on today's date.
const REF = makeQrr(21);
const THIS_YEAR = Number(localToday().slice(0, 4));
const credit = (month: string) => `${THIS_YEAR}-${month}`;

async function setup() {
  const user = await createTestUser();
  const threeA = seedPillar3aAccount(user.id);
  const portfolio = seedPortfolio(user.id, threeA.id, {
    name: "P1",
    depositReference: REF,
  });
  const current = seedAccount(user.id, { name: "Current" });
  return { user, threeA, portfolio, current };
}

const manual = (
  portfolioId: string,
  over: Record<string, string> = {},
): Record<string, string> => ({
  portfolioId,
  date: credit("03-01"),
  amount: "1000.00",
  kind: "ordinary",
  gapYears: "",
  note: "",
  ...over,
});

describe("pillar 3a page", () => {
  useTestDB();

  it("loads an empty state without a 3a account", async () => {
    const u = await createTestUser();
    const data = await loadAs(u);
    expect(data.accounts).toEqual([]);
    expect(data.contributions).toEqual([]);
    expect(data.overview.portfolios).toEqual([]);
  });

  it("loads the accounts, overview and contributions", async () => {
    const { user, threeA, portfolio } = await setup();
    await run("addContribution", user, manual(portfolio.id));
    const data = await loadAs(user);
    expect(data.accounts).toEqual([
      { id: threeA.id, name: threeA.name, archived: false },
    ]);
    expect(
      data.overview.portfolios.map(
        (p: { portfolioId: string }) => p.portfolioId,
      ),
    ).toEqual([portfolio.id]);
    expect(data.contributions).toHaveLength(1);
    expect(data.overview.years[0]).toMatchObject({
      year: THIS_YEAR,
      ordinary: 100_000,
    });
  });

  it("sets the deduction of a year, with income only for the large one", async () => {
    const { user } = await setup();
    expect(
      await run("setYear", user, {
        year: String(THIS_YEAR),
        deduction: "large",
        earnedIncome: "100000.00",
      }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listYearSettings(user.id)).toEqual([
      { year: THIS_YEAR, deduction: "large", earnedIncome: 10_000_000 },
    ]);
    await run("setYear", user, {
      year: String(THIS_YEAR),
      deduction: "small",
      earnedIncome: "5000",
    });
    expect(listYearSettings(user.id)[0]).toMatchObject({
      deduction: "small",
      earnedIncome: null,
    });
    const bad = await run("setYear", user, {
      year: String(THIS_YEAR),
      deduction: "huge",
    });
    expect(bad).toMatchObject({
      type: "fail",
      status: 400,
      data: { action: "setYear", errors: { deduction: expect.any(Array) } },
    });
  });

  it("adds, edits and deletes a manual contribution", async () => {
    const { user, portfolio } = await setup();
    expect(
      await run("addContribution", user, manual(portfolio.id)),
    ).toMatchObject({
      type: "return",
      value: { success: true, action: "addContribution", warnings: [] },
    });
    const [c] = listContributions(user.id);
    expect(c).toMatchObject({
      source: "manual",
      amount: 100_000,
      kind: "ordinary",
    });

    expect(
      await run(
        "updateContribution",
        user,
        manual(portfolio.id, {
          contributionId: c!.id!,
          amount: "2000",
          note: "x",
        }),
      ),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listContributions(user.id)[0]).toMatchObject({
      amount: 200_000,
      note: "x",
    });

    expect(
      await run("deleteContribution", user, { contributionId: c!.id! }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listContributions(user.id)).toEqual([]);
  });

  it("validates a contribution and echoes the values", async () => {
    const { user, portfolio } = await setup();
    const r = await run(
      "addContribution",
      user,
      manual(portfolio.id, { amount: "-5", date: "nope" }),
    );
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "addContribution",
        errors: { amount: expect.any(Array), date: expect.any(Array) },
        values: { amount: "-5", date: "nope" },
      },
    });
    expect(listContributions(user.id)).toEqual([]);
  });

  it("marks a detected payment as a buy-in, once per gap year", async () => {
    const { user, current } = await setup();
    const tx1 = seedImportedTransaction(user.id, current.id, {
      reference: REF,
      amount: minor(-100_000),
      bookingDate: credit("02-01"),
      currency: "CHF",
    });
    const tx2 = seedImportedTransaction(user.id, current.id, {
      reference: REF,
      amount: minor(-100_000),
      bookingDate: credit("02-02"),
      currency: "CHF",
    });
    const detected = (await loadAs(user)).contributions;
    expect(detected.map((c: { source: string }) => c.source)).toEqual([
      "detected",
      "detected",
    ]);

    const buyIn = (transactionId: string) => ({
      transactionId,
      date: credit("02-01"),
      kind: "buy_in",
      gapYears: "2025",
      note: "",
    });
    expect(await run("updateContribution", user, buyIn(tx1.id))).toMatchObject({
      type: "return",
      value: { success: true, action: "updateContribution" },
    });
    expect(
      listContributions(user.id).find((c) => c.transactionId === tx1.id),
    ).toMatchObject({ kind: "buy_in", gapYears: [2025], source: "detected" });
    expect(
      pillar3aOverview(user.id, localToday()).years.find(
        (y) => y.year === 2025,
      ),
    ).toMatchObject({ closedBy: expect.any(String) });

    const second = await run("updateContribution", user, buyIn(tx2.id));
    expect(second).toMatchObject({ type: "fail", status: 400 });
    expect(
      listContributions(user.id).find((c) => c.transactionId === tx2.id),
    ).toMatchObject({ kind: "ordinary", gapYears: [] });

    // Resetting the annotation releases the gap year again.
    expect(
      await run("deleteContribution", user, { transactionId: tx1.id }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(
      listContributions(user.id).find((c) => c.transactionId === tx1.id),
    ).toMatchObject({ kind: "ordinary", gapYears: [] });
  });

  describe("cross-user", () => {
    it("never shows another user's data", async () => {
      const { portfolio, user } = await setup();
      await run("addContribution", user, manual(portfolio.id));
      const b = await createTestUser();
      const data = await loadAs(b);
      expect(data.accounts).toEqual([]);
      expect(data.contributions).toEqual([]);
      expect(data.overview.portfolios).toEqual([]);
      expect(data.overview.totals.contributed).toBe(0);
    });

    it("refuses A's portfolio, contributions and payments for B", async () => {
      const { user: a, current, portfolio } = await setup();
      await run("addContribution", a, manual(portfolio.id));
      const [c] = listContributions(a.id);
      const tx = seedImportedTransaction(a.id, current.id, {
        reference: REF,
        amount: minor(-100_000),
        bookingDate: credit("02-01"),
        currency: "CHF",
      });
      const b = await createTestUser();
      seedPillar3aAccount(b.id);

      const attempts: [keyof typeof actions, Record<string, string>][] = [
        ["addContribution", manual(portfolio.id)],
        [
          "updateContribution",
          manual(portfolio.id, { contributionId: c!.id!, amount: "1" }),
        ],
        [
          "updateContribution",
          {
            transactionId: tx.id,
            date: credit("02-01"),
            kind: "ordinary",
            gapYears: "",
            note: "",
          },
        ],
        ["deleteContribution", { contributionId: c!.id! }],
        ["deleteContribution", { transactionId: tx.id }],
      ];
      for (const [name, form] of attempts) {
        expect(await run(name, b, form), name).toEqual({
          type: "error",
          status: 404,
        });
      }
      const still = listContributions(a.id);
      expect(still.filter((x) => x.source === "manual")).toHaveLength(1);
      expect(still.find((x) => x.id === c!.id)).toMatchObject({
        amount: 100_000,
      });
      expect(listContributions(b.id)).toEqual([]);
    });

    it("keeps year settings per user", async () => {
      const { user: a } = await setup();
      const b = await createTestUser();
      await run("setYear", a, { year: "2026", deduction: "none" });
      expect(listYearSettings(b.id)).toEqual([]);
      await run("setYear", b, { year: "2026", deduction: "large" });
      expect(listYearSettings(a.id)).toMatchObject([{ deduction: "none" }]);
    });
  });
});
