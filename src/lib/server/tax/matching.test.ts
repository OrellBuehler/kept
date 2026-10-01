import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import {
  computeBalance,
  dayDistance,
  matchLines,
  type MineLine,
  type OfficeLine,
} from "./matching";

const mine = (
  id: string,
  date: string,
  cents: number,
  reference: string | null = null,
): MineLine => ({ id, date, amount: minor(cents), reference });
const office = (
  id: string,
  date: string,
  cents: number,
  reference: string | null = null,
): OfficeLine => ({ id, date, amount: minor(cents), reference });

describe("dayDistance", () => {
  it("counts calendar days across month and year ends", () => {
    expect(dayDistance("2025-12-31", "2026-01-02")).toBe(2);
    expect(dayDistance("2026-03-01", "2026-02-27")).toBe(2);
    expect(dayDistance("2026-03-01", "2026-03-01")).toBe(0);
  });
});

describe("matchLines", () => {
  it("pairs equal amounts within the date tolerance", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000)],
      [office("o1", "2025-03-14", 100000)],
    );
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({
      status: "matched",
      difference: 0,
      reason: "amount_date",
    });
    expect(r.mineOnly).toEqual([]);
    expect(r.officeOnly).toEqual([]);
  });

  it("does not pair equal amounts outside the tolerance", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000)],
      [office("o1", "2025-04-30", 100000)],
    );
    expect(r.pairs).toEqual([]);
    expect(r.mineOnly.map((l) => l.id)).toEqual(["m1"]);
    expect(r.officeOnly.map((l) => l.id)).toEqual(["o1"]);
  });

  it("honours a custom tolerance", () => {
    const m = [mine("m1", "2025-03-10", 5000)];
    const o = [office("o1", "2025-03-20", 5000)];
    expect(matchLines(m, o).pairs).toHaveLength(0);
    expect(matchLines(m, o, { dateToleranceDays: 10 }).pairs).toHaveLength(1);
  });

  it("matches by reference regardless of the date gap", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000, "21 00000 00003 13947 14300 09017")],
      [office("o1", "2025-06-30", 100000, "210000000003139471430009017")],
    );
    expect(r.pairs[0]).toMatchObject({
      status: "matched",
      reason: "reference_amount",
    });
  });

  it("flags a reference match with a different amount as a mismatch", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000, "REF1")],
      [office("o1", "2025-03-12", 90000, "ref1")],
    );
    expect(r.pairs[0]).toMatchObject({
      status: "amount_mismatch",
      difference: 10000,
      reason: "reference",
    });
  });

  it("flags a different amount on nearby dates as a mismatch", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000)],
      [office("o1", "2025-03-11", 99000)],
    );
    expect(r.pairs[0]).toMatchObject({
      status: "amount_mismatch",
      difference: 1000,
      reason: "date",
    });
  });

  it("never pairs lines whose references contradict each other by date alone", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000, "AAA")],
      [office("o1", "2025-03-11", 99000, "BBB")],
    );
    expect(r.pairs).toEqual([]);
  });

  it("prefers an exact amount over a closer date with a different amount", () => {
    const r = matchLines(
      [mine("m1", "2025-03-10", 100000)],
      [
        office("near", "2025-03-10", 40000),
        office("exact", "2025-03-15", 100000),
      ],
    );
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.office.id).toBe("exact");
    expect(r.officeOnly.map((l) => l.id)).toEqual(["near"]);
  });

  it("splits identical instalments by closest date, one to one", () => {
    const r = matchLines(
      [mine("a", "2025-03-10", 100000), mine("b", "2025-06-10", 100000)],
      [office("y", "2025-06-12", 100000), office("x", "2025-03-12", 100000)],
    );
    const byMine = Object.fromEntries(
      r.pairs.map((p) => [p.mine.id, p.office.id]),
    );
    expect(byMine).toEqual({ a: "x", b: "y" });
  });

  it("reports partial payments: only the counted instalment pairs up", () => {
    const r = matchLines(
      [mine("a", "2025-03-10", 100000), mine("b", "2025-06-10", 100000)],
      [office("x", "2025-03-12", 100000)],
    );
    expect(r.pairs.map((p) => p.mine.id)).toEqual(["a"]);
    expect(r.mineOnly.map((l) => l.id)).toEqual(["b"]);
    expect(r.officeOnly).toEqual([]);
  });

  it("reports lines on their side that you do not have", () => {
    const r = matchLines([], [office("o1", "2025-03-12", 100000)]);
    expect(r.officeOnly.map((l) => l.id)).toEqual(["o1"]);
  });

  it("matches a refund on both sides (negative amounts)", () => {
    const r = matchLines(
      [mine("m1", "2026-02-01", -25000)],
      [office("o1", "2026-02-03", -25000)],
    );
    expect(r.pairs[0]!.status).toBe("matched");
  });

  it("does not pair a payment with a refund of the same size", () => {
    const r = matchLines(
      [mine("m1", "2026-02-01", 25000)],
      [office("o1", "2026-02-03", -25000)],
    );
    expect(r.pairs[0]!.status).toBe("amount_mismatch");
    expect(r.pairs[0]!.difference).toBe(50000);
  });

  it("is deterministic for ties", () => {
    const m = [mine("a", "2025-03-10", 100), mine("b", "2025-03-10", 100)];
    const o = [office("x", "2025-03-10", 100), office("y", "2025-03-10", 100)];
    const r = matchLines(m, o);
    expect(r.pairs.map((p) => [p.mine.id, p.office.id])).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });
});

describe("computeBalance", () => {
  const lines = (...cents: number[]) =>
    cents.map((c) => ({ amount: minor(c) }));

  it("is due while installments are outstanding", () => {
    const b = computeBalance(
      lines(100000, 100000),
      lines(100000, 100000),
      minor(300000),
    );
    expect(b).toMatchObject({
      paidByMe: 200000,
      creditedByOffice: 200000,
      difference: 0,
      remaining: 100000,
      remainingByMe: 100000,
      outcome: "due",
      amountDue: 100000,
      refundExpected: 0,
    });
  });

  it("is a refund when more was credited than assessed", () => {
    const b = computeBalance(lines(350000), lines(350000), minor(300000));
    expect(b).toMatchObject({
      remaining: -50000,
      outcome: "refund",
      amountDue: 0,
      refundExpected: 50000,
    });
  });

  it("is settled at the exact assessed amount", () => {
    const b = computeBalance(lines(300000), lines(300000), minor(300000));
    expect(b.outcome).toBe("settled");
    expect(b.remaining).toBe(0);
  });

  it("uses the office's figure for the remainder and shows your own beside it", () => {
    const b = computeBalance(lines(300000), lines(200000), minor(300000));
    expect(b.remaining).toBe(100000);
    expect(b.remainingByMe).toBe(0);
    expect(b.difference).toBe(100000);
  });

  it("nets repayments from the office against payments", () => {
    const b = computeBalance(
      lines(300000, -20000),
      lines(300000, -20000),
      minor(280000),
    );
    expect(b.paidByMe).toBe(280000);
    expect(b.outcome).toBe("settled");
  });

  it("is unknown without an assessment", () => {
    const b = computeBalance(lines(1000), lines(1000), null);
    expect(b).toMatchObject({
      remaining: null,
      remainingByMe: null,
      outcome: "unknown",
      amountDue: 0,
      refundExpected: 0,
    });
  });
});
