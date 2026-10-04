import { describe, expect, it } from "vitest";
import { pdfText } from "$lib/testing/pdf";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { LedgerError } from "$lib/server/ledger/errors";
import { buildReport } from "$lib/server/reports";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { updateDetectedContribution } from "$lib/server/pillar3a";
import {
  deductionSummary,
  listDeductionMappings,
  setCategoryDeduction,
  setTransactionDeductionExcluded,
  setTransactionDeductionYear,
} from "./deductions";

const setup = async () => {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const cat = async (name: string, parentId: string | null = null) =>
    await createCategory(user.id, {
      name,
      kind: "expense",
      parentId,
      color: null,
      icon: null,
    });
  const tx = async (cents: number, bookingDate: string, over = {}) =>
    await seedImportedTransaction(user.id, account.id, {
      amount: minor(cents),
      bookingDate,
      ...over,
    });
  return { user, account, cat, tx };
};

describe("deduction summary", () => {
  useTestDB();

  it("sums spending per type and lets refunds reduce the total", async () => {
    const { user, cat, tx } = await setup();
    const gifts = await cat("Gifts");
    await setCategoryDeduction(user.id, gifts.id, "donations");
    await tx(-10000, "2025-03-01", { categoryId: gifts.id });
    await tx(-5000, "2025-04-01", { categoryId: gifts.id });
    await tx(2000, "2025-05-01", { categoryId: gifts.id });
    await tx(-9999, "2025-05-01");

    const s = await deductionSummary(user.id, 2025);
    expect(s.totals).toHaveLength(1);
    expect(s.totals[0]).toMatchObject({
      type: "donations",
      currency: "CHF",
      total: 13000,
    });
    expect(s.totals[0]!.lines.map((l) => l.amount)).toEqual([
      10000, 5000, -2000,
    ]);
  });

  it("keeps currencies apart", async () => {
    const { user, cat, tx } = await setup();
    const med = await cat("Doctor");
    await setCategoryDeduction(user.id, med.id, "medical");
    await tx(-1000, "2025-01-10", { categoryId: med.id });
    await tx(-2500, "2025-01-11", { categoryId: med.id, currency: "EUR" });

    const s = await deductionSummary(user.id, 2025);
    expect(s.totals.map((t) => [t.currency, t.total])).toEqual([
      ["CHF", 1000],
      ["EUR", 2500],
    ]);
  });

  it("uses the explicit deduction year over the booking date, across the year boundary", async () => {
    const { user, cat, tx } = await setup();
    const pillar = await cat("Retirement");
    await setCategoryDeduction(user.id, pillar.id, "pillar_3a");
    await tx(-100, "2026-01-02", {
      categoryId: pillar.id,
      deductionYear: 2025,
    });
    await tx(-200, "2025-12-30", {
      categoryId: pillar.id,
      deductionYear: 2026,
    });
    await tx(-400, "2025-12-31", { categoryId: pillar.id });
    await tx(-800, "2026-01-01", { categoryId: pillar.id });

    const y2025 = await deductionSummary(user.id, 2025);
    expect(y2025.totals[0]!.total).toBe(500);
    expect(y2025.totals[0]!.lines.map((l) => l.explicitYear)).toEqual([
      false,
      true,
    ]);
    expect((await deductionSummary(user.id, 2026)).totals[0]!.total).toBe(1000);
  });

  it("a tax-office payment tag does not move a deduction to that year", async () => {
    const { user, cat, tx } = await setup();
    const gifts = await cat("Gifts");
    await setCategoryDeduction(user.id, gifts.id, "donations");
    await tx(-100, "2025-03-01", { categoryId: gifts.id, taxYear: 2024 });
    expect((await deductionSummary(user.id, 2024)).totals).toEqual([]);
    expect((await deductionSummary(user.id, 2025)).totals[0]!.total).toBe(100);
  });

  it("setTransactionDeductionYear sets and clears the override", async () => {
    const { user, cat, tx } = await setup();
    const gifts = await cat("Gifts");
    await setCategoryDeduction(user.id, gifts.id, "donations");
    const t = await tx(-100, "2025-01-02", { categoryId: gifts.id });
    await setTransactionDeductionYear(user.id, t.id, 2024);
    expect((await deductionSummary(user.id, 2024)).totals[0]!.total).toBe(100);
    expect((await deductionSummary(user.id, 2025)).totals).toEqual([]);
    await setTransactionDeductionYear(user.id, t.id, null);
    expect((await deductionSummary(user.id, 2025)).totals[0]!.total).toBe(100);
  });

  it("cannot set the deduction year of another user's transaction", async () => {
    const a = await setup();
    const b = await createTestUser();
    const t = await a.tx(-100, "2025-01-02");
    await expect(setTransactionDeductionYear(b.id, t.id, 2024)).rejects.toThrow(
      LedgerError,
    );
  });

  it("excludes individual transactions and lists them separately", async () => {
    const { user, cat, tx } = await setup();
    const c = await cat("Kita");
    await setCategoryDeduction(user.id, c.id, "childcare");
    const a = await tx(-3000, "2025-02-01", { categoryId: c.id });
    await tx(-1000, "2025-02-02", { categoryId: c.id });
    await setTransactionDeductionExcluded(user.id, a.id, true);

    let s = await deductionSummary(user.id, 2025);
    expect(s.totals[0]!.total).toBe(1000);
    expect(s.excluded.map((l) => [l.transactionId, l.type])).toEqual([
      [a.id, "childcare"],
    ]);

    await setTransactionDeductionExcluded(user.id, a.id, false);
    s = await deductionSummary(user.id, 2025);
    expect(s.totals[0]!.total).toBe(4000);
    expect(s.excluded).toEqual([]);
  });

  it("drops a type whose lines are all excluded", async () => {
    const { user, cat, tx } = await setup();
    const c = await cat("Kita");
    await setCategoryDeduction(user.id, c.id, "childcare");
    const a = await tx(-3000, "2025-02-01", { categoryId: c.id });
    await setTransactionDeductionExcluded(user.id, a.id, true);
    expect((await deductionSummary(user.id, 2025)).totals).toEqual([]);
  });

  it("lets subcategories inherit the parent's mapping unless they have their own", async () => {
    const { user, cat, tx } = await setup();
    const health = await cat("Health");
    const dentist = await cat("Dentist", health.id);
    const gym = await cat("Gym", health.id);
    await setCategoryDeduction(user.id, health.id, "medical");
    await setCategoryDeduction(user.id, gym.id, "other");
    await tx(-1000, "2025-06-01", { categoryId: health.id });
    await tx(-2000, "2025-06-02", { categoryId: dentist.id });
    await tx(-4000, "2025-06-03", { categoryId: gym.id });

    const s = await deductionSummary(user.id, 2025);
    expect(s.totals.map((t) => [t.type, t.total])).toEqual([
      ["medical", 3000],
      ["other", 4000],
    ]);

    const view = await listDeductionMappings(user.id);
    const dentistView = view.find((v) => v.categoryId === dentist.id)!;
    expect(dentistView).toMatchObject({
      own: null,
      effective: "medical",
      inherited: true,
    });
    expect(view.find((v) => v.categoryId === gym.id)).toMatchObject({
      own: "other",
      effective: "other",
      inherited: false,
    });
  });

  it("clears a mapping", async () => {
    const { user, cat, tx } = await setup();
    const c = await cat("Gifts");
    await setCategoryDeduction(user.id, c.id, "donations");
    await setCategoryDeduction(user.id, c.id, "medical");
    await tx(-1000, "2025-06-01", { categoryId: c.id });
    expect((await deductionSummary(user.id, 2025)).totals[0]!.type).toBe(
      "medical",
    );
    await setCategoryDeduction(user.id, c.id, null);
    expect((await deductionSummary(user.id, 2025)).totals).toEqual([]);
  });

  it("is scoped to the user", async () => {
    const a = await setup();
    const b = await setup();
    const c = await a.cat("Gifts");
    await setCategoryDeduction(a.user.id, c.id, "donations");
    await a.tx(-1000, "2025-06-01", { categoryId: c.id });
    expect((await deductionSummary(b.user.id, 2025)).totals).toEqual([]);
    await expect(
      setCategoryDeduction(b.user.id, c.id, "other"),
    ).rejects.toThrow(LedgerError);
    const t = await a.tx(-1, "2025-06-01");
    await expect(
      setTransactionDeductionExcluded(b.user.id, t.id, true),
    ).rejects.toThrow(LedgerError);
  });

  it("leaves a mapping untouched when another user tries to change or clear it", async () => {
    const a = await setup();
    const b = await setup();
    const c = await a.cat("Gifts");
    await setCategoryDeduction(a.user.id, c.id, "donations");
    await expect(
      setCategoryDeduction(b.user.id, c.id, null),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      setCategoryDeduction(b.user.id, c.id, "medical"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await listDeductionMappings(a.user.id)).find(
        (m) => m.categoryId === c.id,
      ),
    ).toMatchObject({ own: "donations" });
    expect(await listDeductionMappings(b.user.id)).toEqual([]);
  });

  it("renders the PDF report", async () => {
    const { user, cat, tx } = await setup();
    const c = await cat("Gifts");
    await setCategoryDeduction(user.id, c.id, "donations");
    await tx(-12345, "2025-06-01", { categoryId: c.id });
    const built = await buildReport(
      user.id,
      "tax-deductions",
      { year: "2025" },
      "2026-10-15",
    );
    expect(built.fileName).toBe("kept-tax-deductions-2025-2026-10-15.pdf");
    expect(await pdfText(new Uint8Array(built.bytes))).toContain("Donations");

    const err = await buildReport(user.id, "tax-deductions", {}).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LedgerError);
  });
});

describe("deduction summary with detected pillar 3a payments", () => {
  useTestDB();

  const setup3a = async () => {
    const base = await setup();
    const threeA = await seedPillar3aAccount(base.user.id);
    await seedPortfolio(base.user.id, threeA.id, {
      depositReference: makeQrr(1),
    });
    const cat = await base.cat("Retirement");
    await setCategoryDeduction(base.user.id, cat.id, "pillar_3a");
    return { ...base, cat };
  };
  const credit = async (userId: string, transactionId: string, date: string) =>
    await updateDetectedContribution(userId, transactionId, {
      date,
      kind: "ordinary",
      gapYears: [],
      note: null,
    });
  const total = async (userId: string, year: number) =>
    (await deductionSummary(userId, year)).totals.find(
      (t) => t.type === "pillar_3a",
    )?.total ?? 0;

  it("counts a category-mapped payment once, in its credit-date year", async () => {
    const { user, cat, tx } = await setup3a();
    const t = await tx(-50000, "2025-12-28", {
      categoryId: cat.id,
      reference: makeQrr(1),
    });
    await credit(user.id, t.id, "2026-01-05");
    expect(await total(user.id, 2025)).toBe(0);
    const y2026 = await deductionSummary(user.id, 2026);
    expect(y2026.totals[0]!.lines).toHaveLength(1);
    expect(y2026.totals[0]!.lines[0]!.source).toBe("pillar_3a");
    expect(await total(user.id, 2026)).toBe(50000);
  });

  it("ignores an explicit deduction year on a detected payment", async () => {
    const { user, cat, tx } = await setup3a();
    const t = await tx(-50000, "2025-12-28", {
      categoryId: cat.id,
      reference: makeQrr(1),
      deductionYear: 2025,
    });
    await credit(user.id, t.id, "2026-01-05");
    expect(await total(user.id, 2025)).toBe(0);
    expect(await total(user.id, 2026)).toBe(50000);
  });

  it("still lists a detected payment of another deduction type by category", async () => {
    const { user, cat, tx } = await setup3a();
    await setCategoryDeduction(user.id, cat.id, "donations");
    await tx(-50000, "2025-12-28", {
      categoryId: cat.id,
      reference: makeQrr(1),
    });
    const donations = (await deductionSummary(user.id, 2025)).totals.find(
      (t) => t.type === "donations",
    );
    expect(donations).toMatchObject({
      type: "donations",
      total: 50000,
    });
  });

  it("leaves an excluded contribution out of the deductible total only", async () => {
    const { user, tx } = await setup3a();
    const t = await tx(-50000, "2026-02-01", { reference: makeQrr(1) });
    await tx(-20000, "2026-03-01", { reference: makeQrr(1) });
    await setTransactionDeductionExcluded(user.id, t.id, true);
    const s = await deductionSummary(user.id, 2026);
    expect(await total(user.id, 2026)).toBe(20000);
    expect(s.excluded.map((l) => [l.transactionId, l.amount])).toEqual([
      [t.id, 50000],
    ]);
  });
});
