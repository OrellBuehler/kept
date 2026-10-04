import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { minor } from "$lib/money";
import { createCategory } from "$lib/server/categories/categories";
import { LedgerError } from "$lib/server/ledger/errors";
import { buildReport } from "$lib/server/reports";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  deductionSummary,
  listDeductionMappings,
  setCategoryDeduction,
  setTransactionDeductionExcluded,
} from "./deductions";

const setup = async () => {
  const user = await createTestUser();
  const account = seedAccount(user.id);
  const cat = (name: string, parentId: string | null = null) =>
    createCategory(user.id, {
      name,
      kind: "expense",
      parentId,
      color: null,
      icon: null,
    });
  const tx = (cents: number, bookingDate: string, over = {}) =>
    seedImportedTransaction(user.id, account.id, {
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
    const gifts = cat("Gifts");
    setCategoryDeduction(user.id, gifts.id, "donations");
    tx(-10000, "2025-03-01", { categoryId: gifts.id });
    tx(-5000, "2025-04-01", { categoryId: gifts.id });
    tx(2000, "2025-05-01", { categoryId: gifts.id });
    tx(-9999, "2025-05-01");

    const s = deductionSummary(user.id, 2025);
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
    const med = cat("Doctor");
    setCategoryDeduction(user.id, med.id, "medical");
    tx(-1000, "2025-01-10", { categoryId: med.id });
    tx(-2500, "2025-01-11", { categoryId: med.id, currency: "EUR" });

    const s = deductionSummary(user.id, 2025);
    expect(s.totals.map((t) => [t.currency, t.total])).toEqual([
      ["CHF", 1000],
      ["EUR", 2500],
    ]);
  });

  it("uses the explicit tax year over the booking date, across the year boundary", async () => {
    const { user, cat, tx } = await setup();
    const pillar = cat("Retirement");
    setCategoryDeduction(user.id, pillar.id, "pillar_3a");
    tx(-100, "2026-01-02", { categoryId: pillar.id, taxYear: 2025 });
    tx(-200, "2025-12-30", { categoryId: pillar.id, taxYear: 2026 });
    tx(-400, "2025-12-31", { categoryId: pillar.id });
    tx(-800, "2026-01-01", { categoryId: pillar.id });

    const y2025 = deductionSummary(user.id, 2025);
    expect(y2025.totals[0]!.total).toBe(500);
    expect(y2025.totals[0]!.lines.map((l) => l.explicitYear)).toEqual([
      false,
      true,
    ]);
    expect(deductionSummary(user.id, 2026).totals[0]!.total).toBe(1000);
  });

  it("excludes individual transactions and lists them separately", async () => {
    const { user, cat, tx } = await setup();
    const c = cat("Kita");
    setCategoryDeduction(user.id, c.id, "childcare");
    const a = tx(-3000, "2025-02-01", { categoryId: c.id });
    tx(-1000, "2025-02-02", { categoryId: c.id });
    setTransactionDeductionExcluded(user.id, a.id, true);

    let s = deductionSummary(user.id, 2025);
    expect(s.totals[0]!.total).toBe(1000);
    expect(s.excluded.map((l) => [l.transactionId, l.type])).toEqual([
      [a.id, "childcare"],
    ]);

    setTransactionDeductionExcluded(user.id, a.id, false);
    s = deductionSummary(user.id, 2025);
    expect(s.totals[0]!.total).toBe(4000);
    expect(s.excluded).toEqual([]);
  });

  it("drops a type whose lines are all excluded", async () => {
    const { user, cat, tx } = await setup();
    const c = cat("Kita");
    setCategoryDeduction(user.id, c.id, "childcare");
    const a = tx(-3000, "2025-02-01", { categoryId: c.id });
    setTransactionDeductionExcluded(user.id, a.id, true);
    expect(deductionSummary(user.id, 2025).totals).toEqual([]);
  });

  it("lets subcategories inherit the parent's mapping unless they have their own", async () => {
    const { user, cat, tx } = await setup();
    const health = cat("Health");
    const dentist = cat("Dentist", health.id);
    const gym = cat("Gym", health.id);
    setCategoryDeduction(user.id, health.id, "medical");
    setCategoryDeduction(user.id, gym.id, "other");
    tx(-1000, "2025-06-01", { categoryId: health.id });
    tx(-2000, "2025-06-02", { categoryId: dentist.id });
    tx(-4000, "2025-06-03", { categoryId: gym.id });

    const s = deductionSummary(user.id, 2025);
    expect(s.totals.map((t) => [t.type, t.total])).toEqual([
      ["medical", 3000],
      ["other", 4000],
    ]);

    const view = listDeductionMappings(user.id);
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
    const c = cat("Gifts");
    setCategoryDeduction(user.id, c.id, "donations");
    setCategoryDeduction(user.id, c.id, "medical");
    tx(-1000, "2025-06-01", { categoryId: c.id });
    expect(deductionSummary(user.id, 2025).totals[0]!.type).toBe("medical");
    setCategoryDeduction(user.id, c.id, null);
    expect(deductionSummary(user.id, 2025).totals).toEqual([]);
  });

  it("is scoped to the user", async () => {
    const a = await setup();
    const b = await setup();
    const c = a.cat("Gifts");
    setCategoryDeduction(a.user.id, c.id, "donations");
    a.tx(-1000, "2025-06-01", { categoryId: c.id });
    expect(deductionSummary(b.user.id, 2025).totals).toEqual([]);
    expect(() => setCategoryDeduction(b.user.id, c.id, "other")).toThrow(
      LedgerError,
    );
    const t = a.tx(-1, "2025-06-01");
    expect(() =>
      setTransactionDeductionExcluded(b.user.id, t.id, true),
    ).toThrow(LedgerError);
  });

  it("renders the PDF report", async () => {
    const { user, cat, tx } = await setup();
    const c = cat("Gifts");
    setCategoryDeduction(user.id, c.id, "donations");
    tx(-12345, "2025-06-01", { categoryId: c.id });
    const built = await buildReport(
      user.id,
      "tax-deductions",
      { year: "2025" },
      "2026-10-15",
    );
    expect(built.fileName).toBe("kept-tax-deductions-2025-2026-10-15.pdf");
    const pdf = await getDocumentProxy(new Uint8Array(built.bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text).toContain("Donations");

    const err = await buildReport(user.id, "tax-deductions", {}).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LedgerError);
  });
});
