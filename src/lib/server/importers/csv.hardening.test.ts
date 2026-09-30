import { describe, expect, it } from "vitest";
import { buildXlsx } from "../../testing/fixtures/xlsx/build";
import { parseTabular, previewTabular } from "./csv";
import { parseMappingProfile, type CsvMappingProfileInput } from "./mapping";
import { readXlsx } from "./xlsx";

const profile = (input: Partial<CsvMappingProfileInput> & object) =>
  parseMappingProfile({
    amountMode: "single",
    defaultCurrency: "CHF",
    columns: { bookingDate: "Date", amount: "Amount" },
    ...input,
  });

describe("currency exponents", () => {
  const p = profile({
    columns: {
      bookingDate: "Date",
      amount: "Amount",
      currency: "Cur",
      balance: "Balance",
      originalAmount: "OA",
      originalCurrency: "OC",
    },
    defaultCurrency: undefined,
  });
  const table = (...rows: string[][]) => [
    ["Date", "Amount", "Cur", "Balance", "OA", "OC"],
    ...rows,
  ];

  it("parses 3-decimal currencies (KWD) and the original amount's own exponent", () => {
    const [r] = previewTabular(
      table(["2024-01-01", "-12.345", "KWD", "100.000", "2500", "JPY"]),
      p,
    );
    expect(r!.transaction).toMatchObject({
      amount: -12345,
      currency: "KWD",
      originalAmount: -2500,
      originalCurrency: "JPY",
    });
  });

  it("parses 0-decimal currencies (JPY) and rejects fractions", () => {
    const r = previewTabular(
      table(
        ["2024-01-01", "1500", "JPY", "", "", ""],
        ["2024-01-02", "15.50", "JPY", "", "", ""],
        ["2024-01-03", "15.00", "JPY", "", "", ""],
        ["2024-01-04", "1.2345", "KWD", "", "", ""],
        ["2024-01-05", "1", "CHF", "", "2.555", "KWD"],
      ),
      p,
    );
    expect(r[0]!.transaction!.amount).toBe(1500);
    expect(r[1]!.error).toMatch(/more than 0 decimal places/);
    expect(r[2]!.transaction!.amount).toBe(15);
    expect(r[3]!.error).toMatch(/more than 3 decimal places/);
    expect(r[4]!.transaction!.originalAmount).toBe(2555);
  });

  it("derives balances with the currency's exponent", () => {
    const s = parseTabular(
      table(["2024-01-01", "1.500", "KWD", "10.000", "", ""]),
      p,
    );
    expect(s.openingBalance!.amount).toBe(8500);
    expect(s.closingBalance!.amount).toBe(10000);
  });
});

describe("balance chain verification", () => {
  const p = profile({
    columns: { bookingDate: "Date", amount: "Amount", balance: "Balance" },
  });
  const H = ["Date", "Amount", "Balance"];

  it("handles same-day reverse order inside an otherwise ascending file", () => {
    const s = parseTabular(
      [
        H,
        ["2024-01-01", "-10.00", "90.00"],
        ["2024-01-01", "100.00", "100.00"],
        ["2024-01-02", "-5.00", "85.00"],
        ["2024-01-03", "-20.00", "55.00"],
        ["2024-01-03", "-10.00", "75.00"],
      ],
      p,
    );
    expect(s.openingBalance).toMatchObject({ amount: 0, date: "2024-01-01" });
    expect(s.closingBalance).toMatchObject({
      amount: 5500,
      date: "2024-01-03",
    });
  });

  it("returns null balances when the chain cannot be verified", () => {
    const s = parseTabular(
      [
        H,
        ["2024-01-01", "-10.00", "90.00"],
        ["2024-01-01", "100.00", "555.00"],
        ["2024-01-02", "-5.00", "85.00"],
        ["2024-01-02", "-5.00", "1.00"],
      ],
      p,
    );
    expect(s.openingBalance).toBeNull();
    expect(s.closingBalance).toBeNull();
  });

  it("inverts balances together with amounts for invertSign", () => {
    const s = parseTabular(
      [H, ["2024-01-01", "40.00", "240.00"], ["2024-01-02", "10.00", "250.00"]],
      profile({
        invertSign: true,
        columns: { bookingDate: "Date", amount: "Amount", balance: "Balance" },
      }),
    );
    expect(s.transactions.map((t) => t.amount)).toEqual([-4000, -1000]);
    expect(s.openingBalance!.amount).toBe(-20000);
    expect(s.closingBalance!.amount).toBe(-25000);
  });
});

describe("profile strictness", () => {
  it("rejects unknown keys at both levels", () => {
    expect(() =>
      parseMappingProfile({
        amountMode: "single",
        defaultCurrency: "CHF",
        decimalSeperator: ",",
        columns: { bookingDate: "Date", amount: "Amount" },
      }),
    ).toThrow(/decimalSeperator/);
    expect(() =>
      parseMappingProfile({
        amountMode: "single",
        defaultCurrency: "CHF",
        columns: { bookingDate: "Date", amount: "Amount", descripton: "x" },
      }),
    ).toThrow(/descripton/);
  });
});

describe("provided reference ids", () => {
  it("keeps a, a, a#2 distinct", () => {
    const p = profile({
      columns: { externalId: "Ref", bookingDate: "Date", amount: "Amount" },
    });
    const s = parseTabular(
      [
        ["Ref", "Date", "Amount"],
        ["a", "2024-01-01", "1"],
        ["a", "2024-01-01", "1"],
        ["a#2", "2024-01-01", "1"],
        ["50%", "2024-01-01", "1"],
      ],
      p,
    );
    const ids = s.transactions.map((t) => t.externalId);
    expect(ids).toEqual(["ref:a", "ref:a#2", "ref:a%232", "ref:50%25"]);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("error messages do not echo amounts", () => {
  it("uses a fixed message for out-of-range numbers", () => {
    const [r] = previewTabular(
      [
        ["Date", "Amount"],
        ["2024-01-01", "99999999999999999999"],
      ],
      profile({}),
    );
    expect(r!.error).toBe(
      "amount column is not a valid amount (not a valid number)",
    );
  });
});

describe("xlsx number fidelity", () => {
  it("rejects float artefacts instead of silently rounding", () => {
    const rows = readXlsx(
      buildXlsx([
        {
          name: "S",
          rows: [
            ["Date", "Amount"],
            [{ date: "2024-01-01" }, { raw: "0.30000000000000004" }],
            [{ date: "2024-01-02" }, { raw: "0.3" }],
          ],
        },
      ]),
    );
    expect(rows[1]![1]).toBe("0.30000000000000004");
    const r = previewTabular(rows, profile({}));
    expect(r[0]!.error).toMatch(/more than 2 decimal places/);
    expect(r[1]!.transaction!.amount).toBe(30);
  });
});
