import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import {
  annualCost,
  counterpartyKey,
  detectSeries,
  expectedDates,
  monthlyCost,
  priceChange,
  type DetectInput,
} from "./detect";

function tx(
  bookingDate: string,
  amount: number,
  over: Partial<DetectInput> = {},
): DetectInput {
  return {
    bookingDate,
    amount: minor(amount),
    currency: "CHF",
    counterpartyName: "Example Streaming",
    counterpartyIban: null,
    description: null,
    reversal: false,
    ...over,
  };
}

const monthly = (
  day: string,
  amounts: number[],
  over: Partial<DetectInput> = {},
) =>
  amounts.map((a, i) =>
    tx(`2026-${String(i + 1).padStart(2, "0")}-${day}`, a, over),
  );

describe("counterpartyKey", () => {
  it("prefers the IBAN, then the name, then the description", () => {
    const base = {
      counterpartyIban: null,
      counterpartyName: null,
      description: null,
    };
    expect(
      counterpartyKey({
        ...base,
        counterpartyIban: "ch93 0076 2011 6238 5295 7",
        counterpartyName: "X",
      }),
    ).toBe(`iban:${EXAMPLE_IBAN}`);
    expect(
      counterpartyKey({ ...base, counterpartyName: "Café  Müller 1234" }),
    ).toBe("name:cafe muller");
    expect(counterpartyKey({ ...base, description: "Gym fee 04/26" })).toBe(
      "desc:gym fee",
    );
    expect(counterpartyKey(base)).toBeNull();
  });
});

describe("detectSeries", () => {
  it("detects a monthly subscription", () => {
    const [s] = detectSeries(monthly("05", [-1290, -1290, -1290, -1290]));
    expect(s).toMatchObject({
      cadence: "monthly",
      name: "Example Streaming",
      currency: "CHF",
      amount: -1290,
      firstDate: "2026-01-05",
      lastDate: "2026-04-05",
      occurrences: 4,
    });
  });

  it("detects weekly, quarterly and yearly cadences", () => {
    const weekly = [
      "2026-01-02",
      "2026-01-09",
      "2026-01-16",
      "2026-01-23",
      "2026-01-30",
    ].map((d) => tx(d, -500, { counterpartyName: "Weekly Co" }));
    const quarterly = [
      "2025-10-15",
      "2026-01-15",
      "2026-04-15",
      "2026-07-15",
    ].map((d) => tx(d, -8000, { counterpartyName: "Quarterly Co" }));
    const yearly = ["2024-03-01", "2025-03-02", "2026-03-01"].map((d) =>
      tx(d, -12000, { counterpartyName: "Yearly Co" }),
    );
    const found = detectSeries([...weekly, ...quarterly, ...yearly]);
    expect(Object.fromEntries(found.map((s) => [s.name, s.cadence]))).toEqual({
      "Weekly Co": "weekly",
      "Quarterly Co": "quarterly",
      "Yearly Co": "yearly",
    });
  });

  it("needs enough occurrences", () => {
    expect(detectSeries(monthly("05", [-1290, -1290]))).toEqual([]);
    expect(detectSeries([tx("2026-01-05", -1000)])).toEqual([]);
  });

  it("ignores irregular gaps", () => {
    const rows = [
      "2026-01-03",
      "2026-01-19",
      "2026-03-30",
      "2026-04-02",
      "2026-07-21",
    ].map((d) => tx(d, -1000));
    expect(detectSeries(rows)).toEqual([]);
  });

  it("keeps a series with a missing month", () => {
    const rows = [
      "2026-01-05",
      "2026-02-05",
      "2026-04-05",
      "2026-05-05",
      "2026-06-05",
    ].map((d) => tx(d, -1290));
    const [s] = detectSeries(rows);
    expect(s).toMatchObject({ cadence: "monthly", occurrences: 5 });
  });

  it("tolerates bank-day jitter in the booking date", () => {
    const rows = [
      "2026-01-30",
      "2026-03-02",
      "2026-03-31",
      "2026-04-30",
      "2026-06-01",
    ].map((d) => tx(d, -4500));
    expect(detectSeries(rows)[0]?.cadence).toBe("monthly");
  });

  it("follows amount drift and one-off outliers", () => {
    const rows = [
      ...monthly("10", [-9000, -9200, -8900, -9100]),
      tx("2026-05-10", -90000),
    ];
    const [s] = detectSeries(rows);
    expect(s).toMatchObject({
      cadence: "monthly",
      occurrences: 4,
      lastAmount: -9100,
    });
  });

  it("reports a price change through the previous amount", () => {
    const [s] = detectSeries(monthly("05", [-1290, -1290, -1290, -1490]));
    expect(s).toMatchObject({ lastAmount: -1490, previousAmount: -1290 });
    expect(priceChange(s!.lastAmount, s!.previousAmount)).toEqual({
      previous: -1290,
      latest: -1490,
      delta: -200,
    });
  });

  it("splits groups by currency", () => {
    const rows = [
      ...monthly("05", [-1000, -1000, -1000]),
      ...monthly("07", [-1000, -1000, -1000], { currency: "EUR" }),
    ];
    const found = detectSeries(rows);
    expect(found.map((s) => s.currency).sort()).toEqual(["CHF", "EUR"]);
  });

  it("groups by IBAN even when the name varies", () => {
    const iban = EXAMPLE_IBAN;
    const rows = [
      tx("2026-01-05", -2000, {
        counterpartyIban: iban,
        counterpartyName: "Landlord AG",
      }),
      tx("2026-02-05", -2000, {
        counterpartyIban: iban,
        counterpartyName: "LANDLORD AG Zurich",
      }),
      tx("2026-03-05", -2000, {
        counterpartyIban: iban,
        counterpartyName: null,
      }),
    ];
    const [s] = detectSeries(rows);
    expect(s).toMatchObject({
      occurrences: 3,
      counterpartyIban: iban,
      name: "LANDLORD AG Zurich",
    });
  });

  it("separates income from payments to the same payee", () => {
    const rows = [
      ...monthly("25", [500000, 500000, 500000], {
        counterpartyName: "Employer",
      }),
      ...monthly("26", [-500, -500, -500], { counterpartyName: "Employer" }),
    ];
    const found = detectSeries(rows);
    expect(found.map((s) => s.amount).sort((a, b) => a - b)).toEqual([
      -500, 500000,
    ]);
  });

  it("lets a refund cancel the payment it reverses", () => {
    const rows = [
      tx("2026-01-05", -1290),
      tx("2026-02-05", -1290),
      tx("2026-03-05", -1290),
      tx("2026-03-12", 1290),
      tx("2026-04-05", -1290),
    ];
    const [s] = detectSeries(rows);
    expect(s).toMatchObject({ occurrences: 3, lastDate: "2026-04-05" });
    expect(s!.firstDate).toBe("2026-01-05");
  });

  it("drops reversal rows that have no counterpart", () => {
    const rows = [
      ...monthly("05", [-1290, -1290, -1290]),
      tx("2026-04-06", -1290, { reversal: true }),
    ];
    const [s] = detectSeries(rows);
    expect(s?.occurrences).toBe(3);
  });

  it("skips rows without any payee information", () => {
    const rows = monthly("05", [-1000, -1000, -1000], {
      counterpartyName: null,
      description: null,
    });
    expect(detectSeries(rows)).toEqual([]);
  });
});

describe("expectedDates", () => {
  it("counts from the last payment and clamps month ends without drifting", () => {
    expect(
      expectedDates("2026-01-31", "monthly", "2026-02-01", "2026-05-31"),
    ).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("includes both bounds and excludes the last payment itself", () => {
    expect(
      expectedDates("2026-01-05", "weekly", "2026-01-12", "2026-01-26"),
    ).toEqual(["2026-01-12", "2026-01-19", "2026-01-26"]);
    expect(
      expectedDates("2026-01-05", "weekly", "2026-01-05", "2026-01-05"),
    ).toEqual([]);
  });

  it("steps quarterly and yearly", () => {
    expect(
      expectedDates("2026-01-15", "quarterly", "2026-02-01", "2026-12-31"),
    ).toEqual(["2026-04-15", "2026-07-15", "2026-10-15"]);
    expect(
      expectedDates("2026-03-01", "yearly", "2027-01-01", "2028-12-31"),
    ).toEqual(["2027-03-01", "2028-03-01"]);
  });
});

describe("costs and price change", () => {
  it("annualises each cadence exactly", () => {
    expect(annualCost(minor(-1000), "weekly")).toBe(-52000);
    expect(annualCost(minor(-1000), "monthly")).toBe(-12000);
    expect(annualCost(minor(-1000), "quarterly")).toBe(-4000);
    expect(annualCost(minor(-1000), "yearly")).toBe(-1000);
    expect(monthlyCost(minor(-1000), "yearly")).toBe(-83);
  });

  it("ignores changes of 1% or less", () => {
    expect(priceChange(minor(-10050), minor(-10000))).toBeNull();
    expect(priceChange(minor(-10000), null)).toBeNull();
    expect(priceChange(minor(-10200), minor(-10000))?.delta).toBe(-200);
  });
});
