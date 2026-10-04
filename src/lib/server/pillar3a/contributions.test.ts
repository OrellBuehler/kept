import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  getDB,
  pillar3aBuyInYears,
  pillar3aContributions,
  transactions,
} from "$lib/server/db";
import { parseForm } from "$lib/server/forms";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  errorCode,
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import {
  addManualContribution,
  checkBuyIn,
  deleteContribution,
  detectedContributions,
  listContributions,
  updateDetectedContribution,
  updateManualContribution,
} from "./contributions";
import { closePortfolio } from "./portfolios";
import {
  contributionDetailsSchema,
  manualContributionSchema,
  type ContributionDetailsInput,
  type ManualContributionInput,
} from "./schemas";
import { setYearSetting } from "./years";

useTestDB();

const TODAY = "2027-03-01";
const REF_A = makeQrr(1);
const REF_B = makeQrr(2);

async function setup() {
  const user = await createTestUser();
  const threeA = seedPillar3aAccount(user.id);
  const a = seedPortfolio(user.id, threeA.id, {
    name: "A",
    depositReference: REF_A,
  });
  const b = seedPortfolio(user.id, threeA.id, {
    name: "B",
    depositReference: REF_B,
  });
  const current = seedAccount(user.id, { name: "Current" });
  const savings = seedAccount(user.id, { name: "Savings", type: "savings" });
  return { user, threeA, a, b, current, savings };
}

function pay(
  userId: string,
  accountId: string,
  reference: string | null,
  amount: number,
  bookingDate: string,
  extra: Partial<typeof transactions.$inferInsert> = {},
) {
  return seedImportedTransaction(userId, accountId, {
    reference,
    amount: minor(-amount),
    bookingDate,
    currency: "CHF",
    ...extra,
  });
}

const details = (
  over: Partial<ContributionDetailsInput> = {},
): ContributionDetailsInput => ({
  date: "2026-06-01",
  kind: "ordinary",
  gapYears: [],
  note: null,
  ...over,
});

const manual = (
  portfolioId: string,
  over: Partial<ManualContributionInput> = {},
): ManualContributionInput => ({
  portfolioId,
  date: "2026-06-01",
  amount: minor(100_000),
  kind: "ordinary",
  gapYears: [],
  note: null,
  ...over,
});

describe("detectedContributions", () => {
  it("matches outgoing payments by normalized reference across accounts", async () => {
    const { user, a, b, current, savings } = await setup();
    const spaced = `${REF_A.slice(0, 2)} ${REF_A.slice(2, 7)} ${REF_A.slice(7)}`;
    const t1 = pay(user.id, current.id, REF_A, 100_000, "2026-03-01");
    const t2 = pay(user.id, savings.id, spaced, 50_000, "2026-04-01");
    const t3 = pay(user.id, current.id, REF_B, 70_000, "2026-05-01");
    pay(user.id, current.id, makeQrr(99), 10_000, "2026-05-02");
    pay(user.id, current.id, null, 10_000, "2026-05-03");
    const found = detectedContributions(user.id);
    expect(
      found.map((d) => [d.transactionId, d.portfolioId, d.amount, d.accountId]),
    ).toEqual([
      [t3.id, b.id, 70_000, current.id],
      [t2.id, a.id, 50_000, savings.id],
      [t1.id, a.id, 100_000, current.id],
    ]);
  });

  it("ignores incoming payments, foreign currencies and other users", async () => {
    const { user, current } = await setup();
    seedImportedTransaction(user.id, current.id, {
      reference: REF_A,
      amount: minor(5000),
      bookingDate: "2026-03-01",
    });
    pay(user.id, current.id, REF_A, 5000, "2026-03-02", { currency: "EUR" });
    const other = await createTestUser();
    const otherAcc = seedAccount(other.id);
    pay(other.id, otherAcc.id, REF_A, 5000, "2026-03-03");
    expect(detectedContributions(user.id)).toEqual([]);
    expect(detectedContributions(other.id)).toEqual([]);
  });

  it("still matches after the portfolio is closed", async () => {
    const { user, a, current } = await setup();
    pay(user.id, current.id, REF_A, 5000, "2026-03-02");
    closePortfolio(user.id, a.id, {
      closedOn: "2030-01-01",
      closeReason: "wef",
    });
    expect(detectedContributions(user.id)).toHaveLength(1);
  });

  it("does not leak across users with the same reference", async () => {
    const { user, current } = await setup();
    const other = await createTestUser();
    const otherAcc = seedPillar3aAccount(other.id);
    const op = seedPortfolio(other.id, otherAcc.id, {
      depositReference: REF_A,
    });
    const otherCurrent = seedAccount(other.id);
    pay(user.id, current.id, REF_A, 100, "2026-03-02");
    pay(other.id, otherCurrent.id, REF_A, 200, "2026-03-02");
    expect(detectedContributions(user.id).map((d) => d.amount)).toEqual([100]);
    expect(
      detectedContributions(other.id).map((d) => [d.portfolioId, d.amount]),
    ).toEqual([[op.id, 200]]);
  });
});

describe("listContributions", () => {
  it("merges detected and manual rows with the tax year of the credit date", async () => {
    const { user, a, b, current } = await setup();
    pay(user.id, current.id, REF_A, 100_000, "2025-12-29");
    pay(user.id, current.id, REF_A, 200_000, "2026-03-01");
    addManualContribution(
      user.id,
      manual(b.id, { date: "2026-07-01", amount: minor(300_000) }),
      TODAY,
    );
    const all = listContributions(user.id);
    expect(
      all.map((c) => [c.source, c.date, c.year, c.amount, c.portfolioName]),
    ).toEqual([
      ["manual", "2026-07-01", 2026, 300_000, "B"],
      ["detected", "2026-03-01", 2026, 200_000, "A"],
      ["detected", "2025-12-29", 2025, 100_000, "A"],
    ]);
    expect(listContributions(user.id, { year: 2025 })).toHaveLength(1);
    expect(listContributions(user.id, { year: 2026 })).toHaveLength(2);
    expect(listContributions(user.id, { year: 2024 })).toEqual([]);
    expect(all[2]!.lateDecemberWarning).toMatch(/January/);
    expect(all[1]!.lateDecemberWarning).toBeNull();
    expect(a.id).toBe(all[1]!.portfolioId);
  });

  it("is scoped to the user", async () => {
    const { user, b, current } = await setup();
    const other = await createTestUser();
    pay(user.id, current.id, REF_A, 100, "2026-03-01");
    addManualContribution(user.id, manual(b.id), TODAY);
    expect(listContributions(other.id)).toEqual([]);
  });
});

describe("annotating a detected payment", () => {
  it("overrides kind and credit date, never the amount", async () => {
    const { user, current } = await setup();
    const t = pay(user.id, current.id, REF_A, 100_000, "2025-12-29");
    const saved = updateDetectedContribution(
      user.id,
      t.id,
      details({ date: "2026-01-02", note: "credited in January" }),
      TODAY,
    );
    expect(saved.contribution).toMatchObject({
      source: "detected",
      transactionId: t.id,
      date: "2026-01-02",
      bookingDate: "2025-12-29",
      year: 2026,
      amount: 100_000,
      dateOverridden: true,
      lateDecemberWarning: null,
      note: "credited in January",
    });
    getDB()
      .update(transactions)
      .set({ amount: minor(-120_000) })
      .where(eq(transactions.id, t.id))
      .run();
    expect(listContributions(user.id)[0]!.amount).toBe(120_000);
    expect(
      getDB()
        .select()
        .from(pillar3aContributions)
        .where(eq(pillar3aContributions.transactionId, t.id))
        .get(),
    ).toBeDefined();
    updateDetectedContribution(
      user.id,
      t.id,
      details({ date: "2026-01-03" }),
      TODAY,
    );
    expect(getDB().select().from(pillar3aContributions).all()).toHaveLength(1);
  });

  it("deleting the annotation resets the payment", async () => {
    const { user, current } = await setup();
    const t = pay(user.id, current.id, REF_A, 100_000, "2025-12-29");
    updateDetectedContribution(
      user.id,
      t.id,
      details({ date: "2026-01-02" }),
      TODAY,
    );
    deleteContribution(user.id, { transactionId: t.id });
    expect(listContributions(user.id)[0]).toMatchObject({
      id: null,
      date: "2025-12-29",
      kind: "ordinary",
      dateOverridden: false,
    });
    expect(
      errorCode(() => deleteContribution(user.id, { transactionId: t.id })),
    ).toBe("not_found:");
  });

  it("deleting the payment removes its annotation", async () => {
    const { user, current } = await setup();
    const t = pay(user.id, current.id, REF_A, 100_000, "2026-01-05");
    updateDetectedContribution(user.id, t.id, details(), TODAY);
    getDB().delete(transactions).where(eq(transactions.id, t.id)).run();
    expect(getDB().select().from(pillar3aContributions).all()).toEqual([]);
  });

  it("rejects payments that are not detected contributions", async () => {
    const { user, current } = await setup();
    const t = pay(user.id, current.id, makeQrr(77), 100, "2026-01-05");
    expect(
      errorCode(() =>
        updateDetectedContribution(user.id, t.id, details(), TODAY),
      ),
    ).toBe("not_found:");
  });

  it("follows the payment when its reference moves to another portfolio", async () => {
    const { user, a, b, current } = await setup();
    const t = pay(user.id, current.id, REF_A, 100_000, "2026-01-05");
    updateDetectedContribution(user.id, t.id, details({ note: "kept" }), TODAY);
    getDB()
      .update(transactions)
      .set({ reference: REF_B })
      .where(eq(transactions.id, t.id))
      .run();
    const [c] = listContributions(user.id);
    expect(c).toMatchObject({ portfolioId: b.id, note: "kept" });
    expect(c!.portfolioId).not.toBe(a.id);
  });
});

describe("manual contributions", () => {
  it("adds, updates and deletes", async () => {
    const { user, a, b } = await setup();
    const { contribution } = addManualContribution(
      user.id,
      manual(a.id),
      TODAY,
    );
    expect(contribution).toMatchObject({
      source: "manual",
      transactionId: null,
      year: 2026,
      amount: 100_000,
      portfolioName: "A",
      kind: "ordinary",
    });
    const updated = updateManualContribution(
      user.id,
      contribution.id!,
      manual(b.id, { date: "2027-01-02", amount: minor(5000), note: "x" }),
      TODAY,
    );
    expect(updated.contribution).toMatchObject({
      portfolioName: "B",
      year: 2027,
      amount: 5000,
      note: "x",
    });
    deleteContribution(user.id, { id: contribution.id! });
    expect(listContributions(user.id)).toEqual([]);
  });

  it("cannot update a manual row through the annotation of another", async () => {
    const { user, a, current } = await setup();
    const t = pay(user.id, current.id, REF_A, 100, "2026-01-05");
    const annotated = updateDetectedContribution(
      user.id,
      t.id,
      details(),
      TODAY,
    );
    expect(
      errorCode(() =>
        updateManualContribution(
          user.id,
          annotated.contribution.id!,
          manual(a.id),
          TODAY,
        ),
      ),
    ).toBe("not_found:");
  });

  it("parses the forms", () => {
    const f = new FormData();
    f.set("portfolioId", "p");
    f.set("date", "2026-05-01");
    f.set("amount", "1'500.50");
    f.set("kind", "buy_in");
    f.set("gapYears", "2025, 2026");
    expect(parseForm(manualContributionSchema, f)).toEqual({
      ok: true,
      data: {
        portfolioId: "p",
        date: "2026-05-01",
        amount: 150_050,
        kind: "buy_in",
        gapYears: [2025, 2026],
        note: null,
      },
    });
    f.set("amount", "-5");
    expect(parseForm(manualContributionSchema, f).ok).toBe(false);
    f.set("amount", "5");
    f.set("gapYears", "20x5");
    const bad = parseForm(manualContributionSchema, f);
    expect(bad.ok).toBe(false);
    const d = new FormData();
    d.set("date", "2026-05-01");
    d.set("kind", "ordinary");
    expect(parseForm(contributionDetailsSchema, d)).toMatchObject({
      ok: true,
      data: { gapYears: [], note: null },
    });
  });
});

describe("buy-ins", () => {
  it("closes gap years with a detected payment", async () => {
    const { user, current } = await setup();
    const t = pay(user.id, current.id, REF_A, 600_000, "2027-01-15");
    const { contribution, warnings } = updateDetectedContribution(
      user.id,
      t.id,
      details({ date: "2027-01-15", kind: "buy_in", gapYears: [2025] }),
      TODAY,
    );
    expect(contribution).toMatchObject({
      kind: "buy_in",
      gapYears: [2025],
      amount: 600_000,
    });
    expect(warnings.join(" ")).toMatch(/not fully paid/);
  });

  it("rejects closing the same gap year twice", async () => {
    const { user, a } = await setup();
    addManualContribution(
      user.id,
      manual(a.id, {
        date: "2027-01-10",
        kind: "buy_in",
        gapYears: [2025],
        amount: minor(300_000),
      }),
      TODAY,
    );
    expect(
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-02-10",
            kind: "buy_in",
            gapYears: [2025],
            amount: minor(100_000),
          }),
          TODAY,
        ),
      ),
    ).toBe("invalid:gapYears");
    expect(getDB().select().from(pillar3aBuyInYears).all()).toHaveLength(1);
  });

  it("enforces one buy-in per gap year in the database too", async () => {
    const { user, a } = await setup();
    const first = addManualContribution(
      user.id,
      manual(a.id, {
        date: "2027-01-10",
        kind: "buy_in",
        gapYears: [2025],
        amount: minor(300_000),
      }),
      TODAY,
    );
    expect(() =>
      getDB()
        .insert(pillar3aBuyInYears)
        .values({
          userId: user.id,
          contributionId: first.contribution.id!,
          year: 2025,
        })
        .run(),
    ).toThrow();
    const other = await createTestUser();
    const otherAcc = seedPillar3aAccount(other.id);
    const op = seedPortfolio(other.id, otherAcc.id);
    expect(
      errorCode(() =>
        addManualContribution(
          other.id,
          manual(op.id, {
            date: "2027-01-10",
            kind: "buy_in",
            gapYears: [2025],
            amount: minor(300_000),
          }),
          TODAY,
        ),
      ),
    ).toBeUndefined();
  });

  it("maps a database unique violation to a conflict", async () => {
    const { user, a } = await setup();
    const row = getDB()
      .insert(pillar3aContributions)
      .values({
        userId: user.id,
        portfolioId: a.id,
        date: "2027-01-01",
        amount: minor(1),
        kind: "ordinary",
      })
      .returning({ id: pillar3aContributions.id })
      .get();
    getDB()
      .insert(pillar3aBuyInYears)
      .values({ userId: user.id, contributionId: row.id, year: 2025 })
      .run();
    expect(
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-01-10",
            kind: "buy_in",
            gapYears: [2025],
            amount: minor(300_000),
          }),
          TODAY,
        ),
      ),
    ).toBe("conflict:gapYears");
    expect(listContributions(user.id)).toHaveLength(1);
  });

  it("validates years, amounts and the age benefit", async () => {
    const { user, a } = await setup();
    const add = (over: Partial<ManualContributionInput>) =>
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-01-10",
            kind: "buy_in",
            amount: minor(100_000),
            gapYears: [2025],
            ...over,
          }),
          TODAY,
        ),
      );
    expect(add({ gapYears: [2024] })).toBe("invalid:gapYears");
    expect(add({ gapYears: [] })).toBe("invalid:gapYears");
    expect(add({ gapYears: [2027] })).toBe("invalid:gapYears");
    expect(add({ amount: minor(725_801), gapYears: [2025, 2026] })).toBe(
      "invalid:gapYears",
    );
    expect(add({ amount: minor(800_000), gapYears: [2025] })).toBe(
      "invalid:gapYears",
    );
    expect(add({})).toBeUndefined();
    closePortfolio(user.id, a.id, {
      closedOn: "2027-02-01",
      closeReason: "age",
    });
    expect(add({ gapYears: [2026] })).toBe("invalid:gapYears");
  });

  it("does not count buy-ins as ordinary and respects ordinary payments in the gap", async () => {
    const { user, a } = await setup();
    addManualContribution(
      user.id,
      manual(a.id, { date: "2025-05-01", amount: minor(700_000) }),
      TODAY,
    );
    expect(
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-01-10",
            kind: "buy_in",
            gapYears: [2025],
            amount: minor(100_000),
          }),
          TODAY,
        ),
      ),
    ).toBe("invalid:gapYears");
    expect(
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-01-10",
            kind: "buy_in",
            gapYears: [2026],
            amount: minor(100_000),
          }),
          TODAY,
        ),
      ),
    ).toBeUndefined();
  });

  it("honours the deduction setting of a gap year", async () => {
    const { user, a } = await setup();
    setYearSetting(user.id, {
      year: 2025,
      deduction: "none",
      earnedIncome: null,
    });
    setYearSetting(user.id, {
      year: 2026,
      deduction: "small",
      earnedIncome: null,
    });
    const add = (year: number) =>
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-01-10",
            kind: "buy_in",
            gapYears: [year],
            amount: minor(100_000),
          }),
          TODAY,
        ),
      );
    expect(add(2025)).toBe("invalid:gapYears");
    expect(add(2026)).toBeUndefined();
  });

  it("lets a buy-in keep its own years when edited and releases them as ordinary", async () => {
    const { user, a } = await setup();
    const saved = addManualContribution(
      user.id,
      manual(a.id, {
        date: "2027-01-10",
        kind: "buy_in",
        gapYears: [2025],
        amount: minor(300_000),
      }),
      TODAY,
    );
    const id = saved.contribution.id!;
    const edited = updateManualContribution(
      user.id,
      id,
      manual(a.id, {
        date: "2027-01-10",
        kind: "buy_in",
        gapYears: [2025, 2026],
        amount: minor(400_000),
      }),
      TODAY,
    );
    expect(edited.contribution.gapYears).toEqual([2025, 2026]);
    const ordinary = updateManualContribution(
      user.id,
      id,
      manual(a.id, {
        date: "2027-01-10",
        amount: minor(400_000),
        gapYears: [2025],
      }),
      TODAY,
    );
    expect(ordinary.contribution).toMatchObject({
      kind: "ordinary",
      gapYears: [],
    });
    expect(getDB().select().from(pillar3aBuyInYears).all()).toEqual([]);
    expect(
      errorCode(() =>
        addManualContribution(
          user.id,
          manual(a.id, {
            date: "2027-02-10",
            kind: "buy_in",
            gapYears: [2025],
            amount: minor(100_000),
          }),
          TODAY,
        ),
      ),
    ).toBeUndefined();
  });

  it("releases the gap years when the buy-in is deleted", async () => {
    const { user, a } = await setup();
    const saved = addManualContribution(
      user.id,
      manual(a.id, {
        date: "2027-01-10",
        kind: "buy_in",
        gapYears: [2025],
        amount: minor(300_000),
      }),
      TODAY,
    );
    deleteContribution(user.id, { id: saved.contribution.id! });
    expect(getDB().select().from(pillar3aBuyInYears).all()).toEqual([]);
  });

  it("drops annotations of payments that no longer match before validating", async () => {
    const { user, current, a } = await setup();
    const t = pay(user.id, current.id, REF_A, 300_000, "2027-01-15");
    updateDetectedContribution(
      user.id,
      t.id,
      details({ date: "2027-01-15", kind: "buy_in", gapYears: [2025] }),
      TODAY,
    );
    getDB()
      .update(transactions)
      .set({ reference: makeQrr(55) })
      .where(eq(transactions.id, t.id))
      .run();
    const saved = addManualContribution(
      user.id,
      manual(a.id, {
        date: "2027-02-01",
        kind: "buy_in",
        gapYears: [2025],
        amount: minor(100_000),
      }),
      TODAY,
    );
    expect(saved.contribution.gapYears).toEqual([2025]);
    expect(getDB().select().from(pillar3aContributions).all()).toHaveLength(1);
  });

  it("previews the rules without saving", async () => {
    const { user, a } = await setup();
    const preview = checkBuyIn(
      user.id,
      { date: "2027-01-10", amount: minor(100_000), gapYears: [2025, 2024] },
      TODAY,
    );
    expect(preview.errors.join(" ")).toMatch(/2024/);
    expect(preview.warnings.join(" ")).toMatch(/not fully paid/);
    expect(getDB().select().from(pillar3aContributions).all()).toEqual([]);
    expect(a.id).toBeDefined();
  });

  it("does not warn once the ordinary contribution of the year is paid", async () => {
    const { user, a } = await setup();
    addManualContribution(
      user.id,
      manual(a.id, { date: "2027-01-05", amount: minor(725_800) }),
      TODAY,
    );
    const saved = addManualContribution(
      user.id,
      manual(a.id, {
        date: "2027-01-10",
        kind: "buy_in",
        gapYears: [2025],
        amount: minor(100_000),
      }),
      TODAY,
    );
    expect(saved.warnings).toEqual([]);
  });
});

describe("cross-user access", () => {
  it("answers 404 for another user's contributions and portfolios", async () => {
    const { user, a, current } = await setup();
    const other = await createTestUser();
    const otherAcc = seedPillar3aAccount(other.id);
    const op = seedPortfolio(other.id, otherAcc.id);
    const t = pay(user.id, current.id, REF_A, 100, "2026-01-05");
    const saved = addManualContribution(user.id, manual(a.id), TODAY);
    const id = saved.contribution.id!;
    expect(
      errorCode(() =>
        updateDetectedContribution(other.id, t.id, details(), TODAY),
      ),
    ).toBe("not_found:");
    expect(
      errorCode(() =>
        updateManualContribution(other.id, id, manual(op.id), TODAY),
      ),
    ).toBe("not_found:");
    expect(
      errorCode(() => addManualContribution(other.id, manual(a.id), TODAY)),
    ).toBe("not_found:");
    expect(errorCode(() => deleteContribution(other.id, { id }))).toBe(
      "not_found:",
    );
    expect(
      errorCode(() => deleteContribution(other.id, { transactionId: t.id })),
    ).toBe("not_found:");
    expect(listContributions(user.id)).toHaveLength(2);
  });
});
