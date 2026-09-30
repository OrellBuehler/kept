import { describe, expect, it } from "vitest";
import { currencyExponent } from "$lib/money";
import { parseForm } from "$lib/server/forms";
import {
  LEDGER_BIC_11,
  LEDGER_BIC_8,
  LEDGER_IBAN_A,
  LEDGER_IBAN_A_SPACED,
  LEDGER_IBAN_BAD_CHECKSUM,
} from "$lib/testing/fixtures/ledger";
import {
  accountInputSchema,
  institutionInputSchema,
  isRealDate,
  parseListQuery,
  snapshotInputSchema,
  transactionInputSchema,
} from "./schemas";
import { isValidIban, maskIban } from "$lib/iban";

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe("helpers", () => {
  it("validates real calendar dates", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2023-02-29")).toBe(false);
    expect(isRealDate("2024-13-01")).toBe(false);
    expect(isRealDate("24-01-01")).toBe(false);
  });

  it("knows currency exponents", () => {
    expect(currencyExponent("CHF")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("validates IBANs with mod 97 and masks them", () => {
    expect(maskIban(LEDGER_IBAN_A)).toMatch(/^CH93 .*295 7$/);
    expect(maskIban(LEDGER_IBAN_A)).not.toContain("0076");
    expect(isValidIban(LEDGER_IBAN_A)).toBe(true);
    expect(isValidIban(LEDGER_IBAN_A_SPACED)).toBe(true);
    expect(isValidIban(LEDGER_IBAN_BAD_CHECKSUM)).toBe(false);
  });
});

describe("institutionInputSchema", () => {
  it("accepts minimal and full input, normalizing case", () => {
    const min = parseForm(institutionInputSchema, form({ name: " Bank " }));
    expect(min).toEqual({
      ok: true,
      data: { name: "Bank", bic: null, color: null },
    });
    const full = parseForm(
      institutionInputSchema,
      form({ name: "X", bic: LEDGER_BIC_11.toLowerCase(), color: "#ABCDEF" }),
    );
    expect(full).toEqual({
      ok: true,
      data: { name: "X", bic: LEDGER_BIC_11, color: "#abcdef" },
    });
    expect(
      parseForm(institutionInputSchema, form({ name: "X", bic: LEDGER_BIC_8 }))
        .ok,
    ).toBe(true);
  });

  it("rejects bad names, bics and colors", () => {
    const r = parseForm(
      institutionInputSchema,
      form({ name: "", bic: "ABC", color: "red" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.errors).sort()).toEqual(["bic", "color", "name"]);
    expect(
      parseForm(institutionInputSchema, form({ name: "x".repeat(81) })).ok,
    ).toBe(false);
  });
});

describe("accountInputSchema", () => {
  const valid = { name: "Main", type: "current", currency: "chf" };

  it("parses amounts using the currency exponent", () => {
    const r = parseForm(
      accountInputSchema,
      form({
        ...valid,
        openingBalance: "1'234.50",
        iban: LEDGER_IBAN_A_SPACED,
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      data: { currency: "CHF", openingBalance: 123450, iban: LEDGER_IBAN_A },
    });
    const jpy = parseForm(
      accountInputSchema,
      form({ ...valid, currency: "JPY", openingBalance: "500" }),
    );
    expect(jpy).toMatchObject({ ok: true, data: { openingBalance: 500 } });
  });

  it("defaults the balance to zero and rejects too many decimals", () => {
    expect(parseForm(accountInputSchema, form(valid))).toMatchObject({
      ok: true,
      data: { openingBalance: 0, institutionId: null, sortOrder: null },
    });
    const r = parseForm(
      accountInputSchema,
      form({ ...valid, currency: "JPY", openingBalance: "5.5" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.openingBalance).toBeDefined();
  });

  it("reports field errors", () => {
    const r = parseForm(
      accountInputSchema,
      form({
        name: "",
        type: "bogus",
        currency: "CH",
        iban: LEDGER_IBAN_BAD_CHECKSUM,
        openingDate: "2024-02-30",
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual([
        "currency",
        "iban",
        "name",
        "openingDate",
        "type",
      ]);
    }
  });
});

describe("transactionInputSchema", () => {
  const schema = transactionInputSchema("CHF");
  it("parses signed amounts and blank optionals", () => {
    const r = parseForm(
      schema,
      form({ bookingDate: "2024-03-01", amount: "-12,5", description: " " }),
    );
    expect(r).toEqual({
      ok: true,
      data: {
        bookingDate: "2024-03-01",
        valueDate: null,
        amount: -1250,
        counterpartyName: null,
        counterpartyIban: null,
        description: null,
        reference: null,
        note: null,
      },
    });
  });

  it("rejects zero, garbage and bad dates", () => {
    for (const amount of ["0", "0.00", "abc", "1.234", ""]) {
      const r = parseForm(schema, form({ bookingDate: "2024-03-01", amount }));
      expect(r.ok, amount).toBe(false);
    }
    expect(
      parseForm(schema, form({ bookingDate: "2024-3-1", amount: "1" })).ok,
    ).toBe(false);
  });
});

describe("snapshotInputSchema", () => {
  it("allows zero and negative balances", () => {
    const schema = snapshotInputSchema("EUR");
    expect(
      parseForm(schema, form({ date: "2024-01-31", amount: "0" })),
    ).toMatchObject({ ok: true, data: { amount: 0 } });
    expect(
      parseForm(schema, form({ date: "2024-01-31", amount: "-5.25" })),
    ).toMatchObject({ ok: true, data: { amount: -525 } });
  });
});

describe("parseListQuery", () => {
  it("reads filters and paging, clamping page size", () => {
    const q = parseListQuery(
      new URLSearchParams(
        "from=2024-01-01&to=2024-02-01&q=coffee&min=-10&max=5.5&page=3&pageSize=9999",
      ),
      "CHF",
    );
    expect(q.filters).toEqual({
      from: "2024-01-01",
      to: "2024-02-01",
      q: "coffee",
      minAmount: -1000,
      maxAmount: 550,
    });
    expect(q.page).toBe(3);
    expect(q.pageSize).toBe(200);
    expect(q.errors).toEqual({});
  });

  it("ignores invalid values and reports them", () => {
    const q = parseListQuery(
      new URLSearchParams("from=nope&min=abc&page=-2"),
      "CHF",
    );
    expect(q.filters).toEqual({});
    expect(Object.keys(q.errors).sort()).toEqual(["from", "min"]);
    expect(q.raw.from).toBe("nope");
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(50);
  });
});
