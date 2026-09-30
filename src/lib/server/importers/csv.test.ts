import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { fixture } from "../../testing/fixtures";
import {
  detectColumns,
  ImportRowsError,
  parseCsvFile,
  parseTabular,
  parseXlsxFile,
  previewTabular,
} from "./csv";
import { parseMappingProfile, type CsvMappingProfileInput } from "./mapping";
import { readCsv } from "./tabular";
import { ImportFormatError } from "./types";
import { buildXlsx } from "../../testing/fixtures/xlsx/build";
import {
  IBAN_CH,
  IBAN_CH_BAD_CHECK,
  IBAN_CH_SPACED,
  IBAN_DE,
  SCOR,
  SCOR_SPACED,
} from "../../testing/fixtures/values";

const profile = (input: Partial<CsvMappingProfileInput> & object) =>
  parseMappingProfile({
    amountMode: "single",
    defaultCurrency: "CHF",
    columns: { bookingDate: "Date", amount: "Amount" },
    ...input,
  });

const commaDot = profile({
  columns: {
    bookingDate: "Booking Date",
    valueDate: "Value Date",
    counterpartyName: "Counterparty",
    counterpartyIban: "Counterparty IBAN",
    description: "Description",
    reference: "Reference",
    amount: "Amount",
    currency: "Currency",
  },
  defaultCurrency: undefined,
});

describe("comma delimiter, dot decimals", () => {
  const statement = parseCsvFile(fixture("csv/comma-dot.csv"), commaDot);
  const tx = statement.transactions;

  it("maps every field", () => {
    expect(tx).toHaveLength(7);
    expect(tx[0]).toMatchObject({
      bookingDate: "2024-03-01",
      valueDate: "2024-03-01",
      amount: 520000,
      currency: "CHF",
      counterpartyName: "Example Employer AG",
      counterpartyIban: IBAN_CH,
      description: "Salary March",
      reference: null,
      referenceType: null,
      originalAmount: null,
      originalCurrency: null,
      reversal: false,
    });
    expect(statement).toMatchObject({
      accountIban: null,
      accountOtherId: null,
      currency: "CHF",
      fromDate: "2024-03-01",
      toDate: "2024-03-07",
      openingBalance: null,
      closingBalance: null,
    });
  });

  it("handles negative, fractional and zero amounts", () => {
    expect(tx.map((t) => t.amount)).toEqual([
      520000, -450, -450, -12345, -8990, 1230, 0,
    ]);
    expect(Object.is(tx[6]!.amount, 0)).toBe(true);
  });

  it("uses value date distinct from booking date and detects references", () => {
    expect(tx[3]).toMatchObject({
      bookingDate: "2024-03-03",
      valueDate: "2024-03-04",
      counterpartyIban: IBAN_DE,
      reference: "210000000003139471430009017",
      referenceType: "QRR",
    });
    expect(tx[4]).toMatchObject({
      reference: SCOR,
      referenceType: "SCOR",
    });
  });

  it("keeps missing references as null", () => {
    expect(tx[1]!.reference).toBeNull();
    expect(tx[1]!.referenceType).toBeNull();
  });

  it("keeps two identical rows apart with stable occurrence suffixes", () => {
    expect(tx[1]!.externalId).toMatch(/^hash:[0-9a-f]{64}#1$/);
    expect(tx[2]!.externalId).toBe(tx[1]!.externalId.replace(/#1$/, "#2"));
    expect(new Set(tx.map((t) => t.externalId)).size).toBe(7);
  });

  it("is deterministic across parses", () => {
    const again = parseCsvFile(fixture("csv/comma-dot.csv"), commaDot);
    expect(again.transactions.map((t) => t.externalId)).toEqual(
      tx.map((t) => t.externalId),
    );
  });
});

describe("semicolon, decimal comma, apostrophe thousands", () => {
  const p = profile({
    delimiter: ";",
    dateFormat: "DD.MM.YYYY",
    decimalSeparator: ",",
    thousandsSeparator: "'",
    columns: {
      bookingDate: "Buchungsdatum",
      valueDate: "Valuta",
      description: "Text",
      amount: "Betrag",
      currency: "Waehrung",
    },
  });

  it("parses localized amounts and dates", () => {
    const s = parseCsvFile(fixture("csv/semicolon-comma-thousands.csv"), p);
    expect(s.transactions.map((t) => t.amount)).toEqual([
      -185000, 1234560, -5, 100000000,
    ]);
    expect(s.transactions[0]).toMatchObject({
      bookingDate: "2024-03-01",
      description: "Miete Maerz",
    });
    expect(s.transactions[2]!.valueDate).toBe("2024-03-08");
  });

  it("auto-detects the delimiter", () => {
    const s = parseCsvFile(
      fixture("csv/semicolon-comma-thousands.csv"),
      profile({ ...p, delimiter: "auto" } as CsvMappingProfileInput),
    );
    expect(s.transactions).toHaveLength(4);
  });
});

describe("encodings", () => {
  it("decodes windows-1252 umlauts in descriptions", () => {
    const p = profile({
      dateFormat: "DD.MM.YYYY",
      decimalSeparator: ",",
      thousandsSeparator: "'",
      columns: { bookingDate: "Datum", description: "Text", amount: "Betrag" },
    });
    const s = parseCsvFile(fixture("csv/windows-1252-umlauts.csv"), p);
    expect(s.transactions.map((t) => t.description)).toEqual([
      "Bäckerei Müller",
      "Schönenberg Öl AG",
      "Gehalt Größe",
    ]);
    expect(s.transactions[2]!.amount).toBe(300000);
  });

  it("reads UTF-8 with BOM (header lookup works on the first column)", () => {
    const s = parseCsvFile(
      fixture("csv/utf8-bom.csv"),
      profile({
        columns: {
          bookingDate: "Date",
          description: "Text",
          amount: "Amount",
          currency: "Currency",
        },
      }),
    );
    expect(s.transactions[0]).toMatchObject({
      bookingDate: "2024-04-01",
      description: "Café Zürich",
      amount: -620,
    });
  });

  it("reads UTF-16 LE tab separated", () => {
    const s = parseCsvFile(
      fixture("csv/utf16le-bom.csv"),
      profile({ encoding: "utf-16le", delimiter: "\t" }),
    );
    expect(s.transactions).toHaveLength(1);
    expect(s.transactions[0]!.amount).toBe(-310);
  });
});

describe("preamble and footer", () => {
  const p = profile({
    headerRow: 5,
    skipFooterRows: 2,
    dateFormat: "DD.MM.YYYY",
    columns: { bookingDate: "Date", description: "Text", amount: "Amount" },
  });

  it("skips preamble lines, blank lines and footer totals", () => {
    const s = parseCsvFile(fixture("csv/preamble-footer.csv"), p);
    expect(s.transactions.map((t) => [t.description, t.amount])).toEqual([
      ["Opening deposit", 100000],
      ["Sample Cafe", -1240],
      ["Demo Insurance", -4500],
    ]);
  });

  it("fails on footer rows when they are not configured as footer", () => {
    expect(() =>
      parseCsvFile(fixture("csv/preamble-footer.csv"), {
        ...p,
        skipFooterRows: 0,
      }),
    ).toThrow(ImportRowsError);
  });

  it("reports row numbers relative to the file", () => {
    const rows = previewTabular(readCsv(fixture("csv/preamble-footer.csv")), p);
    expect(rows.map((r) => r.rowNumber)).toEqual([6, 7, 9]);
  });

  it("errors when the header row is beyond the file", () => {
    expect(() =>
      parseCsvFile(fixture("csv/preamble-footer.csv"), { ...p, headerRow: 99 }),
    ).toThrow(/beyond the end/);
  });
});

describe("amount modes", () => {
  it("split credit/debit columns, either may be empty", () => {
    const s = parseCsvFile(
      fixture("csv/split-columns.csv"),
      profile({
        amountMode: "split",
        columns: {
          bookingDate: "Date",
          description: "Details",
          credit: "Credit",
          debit: "Debit",
        },
      }),
    );
    expect(s.transactions.map((t) => t.amount)).toEqual([
      300000, -780, -6000, 2500, 0,
    ]);
  });

  it("rejects rows with both credit and debit, or neither", () => {
    const p = profile({
      amountMode: "split",
      columns: { bookingDate: "Date", credit: "C", debit: "D" },
    });
    const rows = [
      ["Date", "C", "D"],
      ["2024-01-01", "5", "3"],
      ["2024-01-02", "", ""],
    ];
    const result = previewTabular(rows, p);
    expect(result[0]!.error).toMatch(/both credit and debit are filled/);
    expect(result[1]!.error).toMatch(/both credit and debit are empty/);
  });

  it("single_with_indicator uses the indicator, not the sign", () => {
    const s = parseCsvFile(
      fixture("csv/indicator.csv"),
      profile({
        amountMode: "single_with_indicator",
        columns: {
          bookingDate: "Date",
          amount: "Amount",
          indicator: "Type",
          description: "Text",
        },
      }),
    );
    expect(s.transactions.map((t) => t.amount)).toEqual([
      250000, -1990, -500, 0,
    ]);
  });

  it("supports configured indicator values, case-insensitively", () => {
    const p = profile({
      amountMode: "single_with_indicator",
      indicatorCreditValues: ["Haben"],
      indicatorDebitValues: ["Soll"],
      columns: { bookingDate: "Date", amount: "Amount", indicator: "DC" },
    });
    const rows = [
      ["Date", "Amount", "DC"],
      ["2024-01-01", "10.00", "haben"],
      ["2024-01-02", "10.00", "SOLL"],
      ["2024-01-03", "10.00", "CRDT"],
      ["2024-01-04", "10.00", ""],
    ];
    const r = previewTabular(rows, p);
    expect(r[0]!.transaction!.amount).toBe(1000);
    expect(r[1]!.transaction!.amount).toBe(-1000);
    expect(r[2]!.error).toMatch(/not configured as credit or debit/);
    expect(r[3]!.error).toMatch(/indicator is empty/);
  });

  it("inverts signs for credit card style exports and keeps original amounts", () => {
    const s = parseCsvFile(
      fixture("csv/credit-card-inverted.csv"),
      profile({
        invertSign: true,
        columns: {
          bookingDate: "Transaction Date",
          counterpartyName: "Merchant",
          amount: "Amount",
          currency: "Currency",
          originalAmount: "Original Amount",
          originalCurrency: "Original Currency",
        },
      }),
    );
    const t = s.transactions;
    expect(t.map((x) => x.amount)).toEqual([-4590, -9215, 20000, -5500]);
    expect(t[0]).toMatchObject({
      originalAmount: null,
      originalCurrency: null,
    });
    expect(t[1]).toMatchObject({
      originalAmount: -10000,
      originalCurrency: "USD",
    });
    expect(t[3]).toMatchObject({
      originalAmount: -5125,
      originalCurrency: "EUR",
    });
  });

  it("rejects a half-filled original amount", () => {
    const p = profile({
      columns: {
        bookingDate: "Date",
        amount: "Amount",
        originalAmount: "OA",
        originalCurrency: "OC",
      },
    });
    const r = previewTabular(
      [
        ["Date", "Amount", "OA", "OC"],
        ["2024-01-01", "1", "2", ""],
      ],
      p,
    );
    expect(r[0]!.error).toMatch(/must both be filled/);
  });
});

describe("quoted fields", () => {
  it("keeps embedded delimiters, quotes and newlines (whitespace-normalized)", () => {
    const s = parseCsvFile(
      fixture("csv/quoted-fields.csv"),
      profile({
        columns: {
          bookingDate: "Date",
          counterpartyName: "Counterparty",
          description: "Description",
          amount: "Amount",
        },
      }),
    );
    expect(
      s.transactions.map((t) => [t.counterpartyName, t.description]),
    ).toEqual([
      ["Example, Sample & Co.", 'Invoice "A-7", net 30 days'],
      ["Demo Services", "Line one line two line three"],
      ["Semi;colon Ltd", "Plain"],
    ]);
  });
});

describe("description columns and column addressing", () => {
  const rows = [
    ["2024-01-01", "x", "Part A", "Part B", "", "5.00"],
    ["2024-01-02", "y", "", "", "", "6.00"],
  ];

  it("joins several description columns and addresses by index without header", () => {
    const p = profile({
      headerRow: 0,
      columns: { bookingDate: 0, description: [2, "3", 4], amount: 5 },
    });
    const s = parseTabular(rows, p);
    expect(s.transactions.map((t) => t.description)).toEqual([
      "Part A / Part B",
      null,
    ]);
  });

  it("matches header names case-insensitively and fails on missing columns", () => {
    const table = [
      ["DATE", "amount"],
      ["2024-01-01", "1.00"],
    ];
    expect(parseTabular(table, profile({})).transactions).toHaveLength(1);
    expect(() =>
      parseTabular(
        table,
        profile({ columns: { bookingDate: "Date", amount: "Sum" } }),
      ),
    ).toThrow(
      /Column "Sum" \(columns\.amount\) not found in header row 1; available columns: "DATE", "amount"/,
    );
  });

  it("treats short rows as empty cells", () => {
    const p = profile({ headerRow: 0, columns: { bookingDate: 0, amount: 3 } });
    const r = previewTabular([["2024-01-01", "a"]], p);
    expect(r[0]!.error).toMatch(/amount column is empty/);
  });
});

describe("dates", () => {
  const dateOf = (format: string, value: string, extra: object = {}) => {
    const p = profile({ dateFormat: format as never, ...extra });
    const [r] = previewTabular(
      [
        ["Date", "Amount"],
        [value, "1.00"],
      ],
      p,
    );
    return r!.transaction?.bookingDate ?? r!.error;
  };

  it.each([
    ["YYYY-MM-DD", "2024-02-29", "2024-02-29"],
    ["DD.MM.YYYY", "5.3.2024", "2024-03-05"],
    ["DD/MM/YYYY", "05/03/2024", "2024-03-05"],
    ["MM/DD/YYYY", "03/05/2024", "2024-03-05"],
    ["YYYYMMDD", "20240305", "2024-03-05"],
    ["DD.MM.YY", "05.03.24", "2024-03-05"],
    ["DD.MM.YY", "05.03.69", "2069-03-05"],
    ["DD.MM.YY", "05.03.70", "1970-03-05"],
    ["DD.MM.YYYY", "05.03.2024 13:45:10", "2024-03-05"],
    ["YYYY-MM-DD", "2024-03-05T13:45:10Z", "2024-03-05"],
    ["DD.MM.YYYY", "2024-03-05", "2024-03-05"],
  ])("%s %s -> %s", (format, value, expected) => {
    expect(dateOf(format, value)).toBe(expected);
  });

  it("honours a custom two-digit-year pivot", () => {
    expect(dateOf("DD.MM.YY", "05.03.30", { twoDigitYearPivot: 30 })).toBe(
      "1930-03-05",
    );
  });

  it("rejects impossible and mismatching dates", () => {
    expect(dateOf("YYYY-MM-DD", "2023-02-29")).toMatch(
      /not a real calendar date/,
    );
    expect(dateOf("DD.MM.YYYY", "31.04.2024")).toMatch(
      /not a real calendar date/,
    );
    expect(dateOf("MM/DD/YYYY", "13/01/2024")).toMatch(
      /not a real calendar date/,
    );
    expect(dateOf("DD.MM.YYYY", "03/05/2024")).toMatch(/does not match/);
    expect(dateOf("YYYY-MM-DD", "")).toMatch(/bookingDate is empty/);
  });
});

describe("amount parsing", () => {
  const amountOf = (value: string, extra: object = {}) => {
    const p = profile(extra);
    const [r] = previewTabular(
      [
        ["Date", "Amount"],
        ["2024-01-01", value],
      ],
      p,
    );
    return r!.transaction ? r!.transaction.amount : r!.error;
  };

  it.each([
    ["1234.5", {}, 123450],
    ["-0.05", {}, -5],
    ["+7", {}, 700],
    ["12.50-", {}, -1250],
    ["(12.50)", {}, -1250],
    ["1.000", {}, 100],
    ["12.500", {}, 1250],
    ["1,234.56", { thousandsSeparator: "," }, 123456],
    ["1.234,56", { decimalSeparator: ",", thousandsSeparator: "." }, 123456],
    ["1 234,56", { decimalSeparator: ",", thousandsSeparator: " " }, 123456],
    ["1 234,56", { decimalSeparator: ",", thousandsSeparator: " " }, 123456],
    ["1’234.56", { thousandsSeparator: "'" }, 123456],
    ["1234,56", { decimalSeparator: ",", thousandsSeparator: "'" }, 123456],
    [".5", {}, 50],
    [",5", { decimalSeparator: "," }, 50],
    ["-.25", {}, -25],
  ])("%s", (value, extra, expected) => {
    expect(amountOf(value, extra)).toBe(minor(expected));
  });

  it.each([
    ["12x.00", {}],
    ["", {}],
    ["1.234", {}],
    ["1,23", { thousandsSeparator: "," }],
    ["1.2.3", {}],
    ["12,50", {}],
    ["--5", {}],
  ])("rejects %j without echoing the value", (value, extra) => {
    const result = amountOf(value, extra);
    expect(result).toEqual(expect.stringMatching(/amount column/));
    if (value) expect(String(result)).not.toContain(value);
  });

  it("rejects an invalid counterparty IBAN", () => {
    const p = profile({
      columns: {
        bookingDate: "Date",
        amount: "Amount",
        counterpartyIban: "IBAN",
      },
    });
    const r = previewTabular(
      [
        ["Date", "Amount", "IBAN"],
        ["2024-01-01", "1", IBAN_CH_SPACED],
        ["2024-01-01", "1", IBAN_CH_BAD_CHECK],
      ],
      p,
    );
    expect(r[0]!.transaction!.counterpartyIban).toBe(IBAN_CH);
    expect(r[1]!.error).toMatch(/not a valid IBAN/);
  });
});

describe("currencies", () => {
  it("uses the currency column and falls back to the default when a cell is empty", () => {
    const p = profile({
      columns: { bookingDate: "Date", amount: "Amount", currency: "Cur" },
    });
    const r = previewTabular(
      [
        ["Date", "Amount", "Cur"],
        ["2024-01-01", "1", "eur"],
        ["2024-01-02", "1", ""],
        ["2024-01-03", "1", "EURO"],
      ],
      p,
    );
    expect(r[0]!.transaction!.currency).toBe("EUR");
    expect(r[1]!.transaction!.currency).toBe("CHF");
    expect(r[2]!.error).toMatch(/not a 3-letter code/);
  });

  it("refuses to merge several currencies into one statement", () => {
    const p = profile({
      defaultCurrency: undefined,
      columns: { bookingDate: "Date", amount: "Amount", currency: "Currency" },
    });
    expect(() => parseCsvFile(fixture("csv/mixed-currencies.csv"), p)).toThrow(
      /mixes currencies \(CHF, EUR\)/,
    );
  });
});

describe("external ids", () => {
  const p = profile({
    columns: {
      externalId: "Entry Ref",
      bookingDate: "Date",
      description: "Text",
      amount: "Amount",
    },
  });

  it("prefixes the bank reference", () => {
    const s = parseCsvFile(fixture("csv/bank-reference.csv"), p);
    expect(s.transactions.map((t) => t.externalId)).toEqual([
      "ref:TXN-0001",
      "ref:TXN-0002",
      "ref:TXN-0003",
    ]);
  });

  it("disambiguates a bank reference repeated within one file", () => {
    const s = parseTabular(
      [
        ["Entry Ref", "Date", "Text", "Amount"],
        ["B1", "2024-01-01", "a", "1"],
        ["B1", "2024-01-01", "b", "2"],
      ],
      p,
    );
    expect(s.transactions.map((t) => t.externalId)).toEqual([
      "ref:B1",
      "ref:B1#2",
    ]);
  });

  it("falls back to a hash when the reference cell is empty", () => {
    const s = parseTabular(
      [
        ["Entry Ref", "Date", "Text", "Amount"],
        ["", "2024-01-01", "a", "1"],
      ],
      p,
    );
    expect(s.transactions[0]!.externalId).toMatch(/^hash:/);
  });

  it("hash ignores column order, balance, whitespace and number formatting", () => {
    const a = parseTabular(
      [
        ["Date", "Text", "Amount", "Balance"],
        ["2024-01-01", "Coffee  shop", "-4.5", "100.00"],
      ],
      profile({
        columns: {
          bookingDate: "Date",
          description: "Text",
          amount: "Amount",
          balance: "Balance",
        },
      }),
    );
    const b = parseTabular(
      [
        ["Amount", "Date", "Text"],
        ["-4.50", "2024-01-01", " Coffee shop "],
      ],
      profile({
        columns: { bookingDate: "Date", description: "Text", amount: "Amount" },
      }),
    );
    expect(a.transactions[0]!.externalId).toBe(b.transactions[0]!.externalId);
  });

  it("hash differs when any booked field differs", () => {
    const s = parseTabular(
      [
        ["Date", "Amount"],
        ["2024-01-01", "1.00"],
        ["2024-01-01", "1.01"],
        ["2024-01-02", "1.00"],
      ],
      profile({}),
    );
    expect(new Set(s.transactions.map((t) => t.externalId)).size).toBe(3);
  });
});

describe("overlapping files", () => {
  const p = profile({
    columns: {
      bookingDate: "Date",
      counterpartyName: "Counterparty",
      description: "Description",
      amount: "Amount",
      currency: "Currency",
    },
    defaultCurrency: undefined,
  });
  const a = parseCsvFile(fixture("csv/overlap-a.csv"), p).transactions;
  const b = parseCsvFile(fixture("csv/overlap-b.csv"), p).transactions;

  it("shares ids for the same bookings, including repeated identical rows", () => {
    const idsA = new Set(a.map((t) => t.externalId));
    const shared = b.filter((t) => idsA.has(t.externalId));
    expect(shared.map((t) => t.bookingDate)).toEqual([
      "2024-08-02",
      "2024-08-02",
      "2024-08-03",
      "2024-08-04",
    ]);
  });

  it("the union by externalId has no duplicates and keeps every booking", () => {
    const union = new Map([...a, ...b].map((t) => [t.externalId, t]));
    expect(union.size).toBe(6);
    expect([...union.values()].reduce((sum, t) => sum + t.amount, 0)).toBe(
      -450 * 3 - 8000 + 400000 - 5900,
    );
  });
});

describe("balances", () => {
  const p = profile({
    columns: {
      bookingDate: "Date",
      description: "Text",
      amount: "Amount",
      balance: "Balance",
    },
  });

  it("derives opening and closing from ascending rows", () => {
    const s = parseCsvFile(fixture("csv/ascending-balance.csv"), p);
    expect(s.openingBalance).toEqual({
      amount: 101000,
      currency: "CHF",
      date: "2024-09-01",
    });
    expect(s.closingBalance).toEqual({
      amount: 145000,
      currency: "CHF",
      date: "2024-09-03",
    });
  });

  it("derives the same balances from descending rows", () => {
    const asc = parseCsvFile(fixture("csv/ascending-balance.csv"), p);
    const desc = parseCsvFile(fixture("csv/descending-balance.csv"), p);
    expect(desc.openingBalance).toEqual(asc.openingBalance);
    expect(desc.closingBalance).toEqual(asc.closingBalance);
    expect(desc.fromDate).toBe("2024-09-01");
    expect(desc.toDate).toBe("2024-09-03");
    expect(desc.transactions[0]!.bookingDate).toBe("2024-09-03");
  });

  it("uses balance continuity when all rows share a date", () => {
    const rows = [
      ["Date", "Text", "Amount", "Balance"],
      ["2024-01-01", "third", "-5.00", "85.00"],
      ["2024-01-01", "second", "-10.00", "90.00"],
      ["2024-01-01", "first", "100.00", "100.00"],
    ];
    const s = parseTabular(rows, p);
    expect(s.openingBalance!.amount).toBe(0);
    expect(s.closingBalance!.amount).toBe(8500);
  });

  it("leaves balances null without a balance column, on empty cells or no rows", () => {
    expect(
      parseCsvFile(
        fixture("csv/ascending-balance.csv"),
        profile({
          columns: { bookingDate: "Date", amount: "Amount" },
        }),
      ).openingBalance,
    ).toBeNull();
    const s = parseTabular(
      [
        ["Date", "Text", "Amount", "Balance"],
        ["2024-01-01", "x", "1.00", ""],
      ],
      p,
    );
    expect(s.openingBalance).toBeNull();
    expect(s.closingBalance).toBeNull();
    expect(
      parseTabular([["Date", "Text", "Amount", "Balance"]], p).closingBalance,
    ).toBeNull();
  });

  it("rejects an invalid balance cell", () => {
    const r = previewTabular(
      [
        ["Date", "Text", "Amount", "Balance"],
        ["2024-01-01", "x", "1.00", "abc"],
      ],
      p,
    );
    expect(r[0]!.error).toMatch(/balance column/);
  });
});

describe("row errors", () => {
  const p = profile({
    columns: { bookingDate: "Date", description: "Text", amount: "Amount" },
  });

  it("previews per-row results with errors instead of throwing", () => {
    const rows = readCsv(fixture("csv/bad-rows.csv"));
    const r = previewTabular(rows, p);
    expect(r.map((x) => [x.rowNumber, x.transaction ? "ok" : x.error])).toEqual(
      [
        [2, "ok"],
        [3, expect.stringMatching(/bookingDate .*not a real calendar date/)],
        [4, expect.stringMatching(/amount column is not a valid amount/)],
        [5, expect.stringMatching(/more than 2 decimal places/)],
        [6, "ok"],
      ],
    );
    expect(r[1]!.raw).toEqual(["2024-13-45", "Invalid date", "10.00"]);
  });

  it("honours the preview limit", () => {
    const rows = readCsv(fixture("csv/bad-rows.csv"));
    expect(previewTabular(rows, p, { limit: 2 })).toHaveLength(2);
  });

  it("parseTabular throws ImportRowsError listing the failed rows, no partial result", () => {
    let error: unknown;
    try {
      parseCsvFile(fixture("csv/bad-rows.csv"), p);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ImportRowsError);
    expect(error).toBeInstanceOf(ImportFormatError);
    const e = error as ImportRowsError;
    expect(e.totalErrors).toBe(3);
    expect(e.rowErrors.map((r) => r.rowNumber)).toEqual([3, 4, 5]);
    expect(e.message).toMatch(
      /^3 rows could not be parsed \(row 3: .*; row 4: .*; row 5: /,
    );
  });

  it("caps the listed errors but reports the total", () => {
    const rows = [["Date", "Text", "Amount"]];
    for (let i = 0; i < 25; i++) rows.push(["nope", "x", "1"]);
    try {
      parseTabular(rows, p);
      expect.unreachable();
    } catch (e) {
      const err = e as ImportRowsError;
      expect(err.totalErrors).toBe(25);
      expect(err.rowErrors).toHaveLength(10);
      expect(err.message).toContain("25 rows");
      expect(err.message).toContain("and 15 more");
    }
  });
});

describe("empty statements", () => {
  it("returns an empty statement for a header-only file", () => {
    const s = parseCsvFile(
      fixture("csv/empty-statement.csv"),
      profile({
        columns: {
          bookingDate: "Date",
          amount: "Amount",
          currency: "Currency",
        },
      }),
    );
    expect(s.transactions).toEqual([]);
    expect(s).toMatchObject({ currency: "CHF", fromDate: null, toDate: null });
  });

  it("uses XXX when no currency can be known", () => {
    const s = parseTabular(
      [["Date", "Amount", "Cur"]],
      profile({
        defaultCurrency: undefined,
        columns: { bookingDate: "Date", amount: "Amount", currency: "Cur" },
      }),
    );
    expect(s.currency).toBe("XXX");
  });

  it("rejects a completely empty file", () => {
    expect(() => parseCsvFile(new Uint8Array(), profile({}))).toThrow(
      /File is empty/,
    );
  });

  it("rejects malformed CSV instead of returning part of it", () => {
    expect(() =>
      parseCsvFile(
        new TextEncoder().encode('Date,Amount\n2024-01-01,"1.00\n'),
        profile({}),
      ),
    ).toThrow(/Unterminated quoted field/);
  });
});

describe("detectColumns", () => {
  const rows = readCsv(fixture("csv/comma-dot.csv"));

  it("returns header names with distinct non-empty samples", () => {
    const cols = detectColumns(rows, 1);
    expect(cols.map((c) => c.name)).toEqual([
      "Booking Date",
      "Value Date",
      "Counterparty",
      "Counterparty IBAN",
      "Description",
      "Reference",
      "Amount",
      "Currency",
    ]);
    expect(cols[2]!.samples).toEqual([
      "Example Employer AG",
      "Sample Cafe",
      "Demo Utilities GmbH",
    ]);
    expect(cols[5]!.samples).toEqual([
      "210000000003139471430009017",
      SCOR_SPACED,
    ]);
    expect(cols[7]!.samples).toEqual(["CHF"]);
  });

  it("names columns by position without a header row and handles preambles", () => {
    const cols = detectColumns(
      [
        ["1", "b"],
        ["2", "c", "d"],
      ],
      0,
    );
    expect(cols.map((c) => c.name)).toEqual([
      "Column 1",
      "Column 2",
      "Column 3",
    ]);
    expect(cols[0]!.samples).toEqual(["1", "2"]);
    const pre = detectColumns(readCsv(fixture("csv/preamble-footer.csv")), 5);
    expect(pre.map((c) => c.name)).toEqual(["Date", "Text", "Amount"]);
    expect(detectColumns([], 3)).toEqual([]);
  });
});

describe("xlsx", () => {
  const p = profile({
    columns: {
      bookingDate: "Date",
      counterpartyName: "Counterparty",
      description: "Description",
      reference: "Reference",
      amount: "Amount",
      currency: "Currency",
    },
    defaultCurrency: undefined,
  });

  it("parses the first sheet into a statement", () => {
    const s = parseXlsxFile(fixture("xlsx/statement.xlsx"), p);
    expect(s.transactions.map((t) => [t.bookingDate, t.amount])).toEqual([
      ["2024-03-01", 520000],
      ["2024-03-02", -450],
      ["2024-03-03", -12345],
      ["2024-03-04", 30],
      ["2024-03-05", 15],
      ["2024-03-06", 0],
    ]);
    expect(s.transactions[1]!.description).toBe("Coffee and cake");
    expect(s.transactions[2]).toMatchObject({
      reference: "210000000003139471430009017",
      referenceType: "QRR",
    });
  });

  it("works with localized profiles: numeric cells follow the decimal separator", () => {
    const bytes = buildXlsx([
      {
        name: "S",
        rows: [
          ["Datum", "Betrag"],
          [{ date: "2024-01-05" }, { raw: "-12.5" }],
          ["05.01.2024", "1'234,50"],
        ],
      },
    ]);
    const s = parseXlsxFile(
      bytes,
      profile({
        dateFormat: "DD.MM.YYYY",
        decimalSeparator: ",",
        thousandsSeparator: "'",
        columns: { bookingDate: "Datum", amount: "Betrag" },
      }),
    );
    expect(s.transactions.map((t) => [t.bookingDate, t.amount])).toEqual([
      ["2024-01-05", -1250],
      ["2024-01-05", 123450],
    ]);
  });
});
