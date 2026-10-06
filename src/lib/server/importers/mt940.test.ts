import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMt940 } from "./mt940";
import { decodeText } from "./tabular";
import {
  IBAN_CH,
  IBAN_DE,
  IBAN_GB,
  REF_SCOR_ISO_EXAMPLE,
} from "../../testing/fixtures/camt053/examples";
import { ImportFormatError, type NormalizedStatement } from "./types";

const dir = join(import.meta.dirname, "../../testing/fixtures/mt940");
const bytes = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const load = (name: string) => decodeText(bytes(name));
const parse = (name: string) => parseMt940(load(name));

function sum(s: NormalizedStatement): number {
  return s.transactions.reduce((acc, t) => acc + t.amount, 0);
}

function statement(body: string): string {
  return `:20:REF\n:25:${IBAN_DE}\n:60F:C240229EUR100,00\n${body}\n:62F:C240331EUR100,00\n-\n`;
}

function bad(text: string, message: RegExp) {
  expect(() => parseMt940(text)).toThrow(ImportFormatError);
  expect(() => parseMt940(text)).toThrow(message);
}

describe("structured :86: with SEPA keywords", () => {
  const [s] = parse("basic.sta");

  it("reads account, balances and statement number", () => {
    expect(parse("basic.sta")).toHaveLength(1);
    expect(s).toMatchObject({
      accountIban: IBAN_DE,
      accountOtherId: null,
      currency: "EUR",
      statementId: "00001/001",
      fromDate: null,
      toDate: null,
    });
    expect(s!.openingBalance).toEqual({
      amount: 100000,
      currency: "EUR",
      date: "2024-03-01",
    });
    expect(s!.closingBalance).toEqual({
      amount: 303050,
      currency: "EUR",
      date: "2024-03-15",
    });
  });

  it("signs from the mark and reconciles with the balances", () => {
    expect(s!.transactions.map((t) => t.amount)).toEqual([
      15000, -11950, 0, 200000,
    ]);
    expect(s!.openingBalance!.amount + sum(s!)).toBe(s!.closingBalance!.amount);
  });

  it("reads counterparty, purpose and keywords of the first entry", () => {
    expect(s!.transactions[0]).toMatchObject({
      externalId: "mt940:EXREF0001:2024-03-01:15000",
      bookingDate: "2024-03-01",
      valueDate: "2024-03-01",
      currency: "EUR",
      counterpartyName: "Jane Example",
      counterpartyIban: IBAN_CH,
      description: "Refund order 77",
      reference: null,
      referenceType: null,
      reversal: false,
      originalAmount: null,
      originalCurrency: null,
    });
  });

  it("uses the entry date for booking and keeps the value date; joins a wrapped name", () => {
    expect(s!.transactions[1]).toMatchObject({
      bookingDate: "2024-03-06",
      valueDate: "2024-03-05",
      counterpartyName: "Example Energy Ltd",
      counterpartyIban: IBAN_GB,
    });
  });

  it("detects a creditor reference in the purpose text", () => {
    expect(s!.transactions[1]).toMatchObject({
      reference: REF_SCOR_ISO_EXAMPLE,
      referenceType: "SCOR",
      description: REF_SCOR_ISO_EXAMPLE.replace(/(.{4})/g, "$1 ").trim(),
    });
  });

  it("joins purpose lines without a separator and prefers IBAN+ keywords", () => {
    expect(s!.transactions[3]).toMatchObject({
      description: "Salary March 2024 includes bonus",
      counterpartyName: "Example Employer AG",
      counterpartyIban: IBAN_CH,
    });
  });

  it("keeps zero amounts and falls back to the posting text/purpose", () => {
    expect(s!.transactions[2]).toMatchObject({
      amount: 0,
      description: "Account fee waived",
      counterpartyName: null,
      counterpartyIban: null,
    });
  });

  it("ignores :64: and an :86: after the closing balance", () => {
    expect(s!.transactions).toHaveLength(4);
  });
});

describe("unstructured :86:", () => {
  const [s] = parse("unstructured.sta");

  it("uses the text lines as description and leaves the counterparty empty", () => {
    expect(s!.transactions[0]).toMatchObject({
      amount: -4510,
      description: "Payment to Sample Insurance AG Premium May 2024",
      counterpartyName: null,
      counterpartyIban: null,
      externalId: "mt940:BR-5001:2024-05-02:-4510",
    });
  });

  it("reads SEPA keywords out of free text", () => {
    expect(s!.transactions[1]).toMatchObject({
      description: "Rent May",
      counterpartyIban: IBAN_DE,
      externalId: "mt940:BR-5002:2024-05-03:-6000",
    });
  });

  it("recognises a QR reference as the only text", () => {
    expect(s!.transactions[2]).toMatchObject({
      amount: 15000,
      reference: "210000000003139471430009017",
      referenceType: "QRR",
    });
  });

  it("falls back to the :61: supplementary line when there is no :86:", () => {
    expect(s!.transactions[3]).toMatchObject({
      amount: -500,
      description: null,
    });
  });

  it("uses the supplementary line as description of an entry without :86:", () => {
    const [t] = parseMt940(
      statement(":61:240301D1,00NMSCNONREF//B1\nSupplementary note"),
    )[0]!.transactions;
    expect(t!.description).toBe("Supplementary note");
  });

  it("reconciles with the balances and takes the currency from the balance", () => {
    expect(s!.currency).toBe("CHF");
    expect(s!.accountIban).toBe(IBAN_CH);
    expect(s!.openingBalance!.amount + sum(s!)).toBe(s!.closingBalance!.amount);
  });
});

describe("multiple statements", () => {
  const list = parse("multi-statement.sta");

  it("returns one statement per :20: in file order", () => {
    expect(list.map((s) => [s.accountIban, s.currency, s.statementId])).toEqual(
      [
        [IBAN_DE, "EUR", "00001/001"],
        [IBAN_DE, "EUR", "00001/002"],
        [IBAN_CH, "CHF", "00007/001"],
      ],
    );
    expect(list.map((s) => s.transactions.map((t) => t.amount))).toEqual([
      [5000],
      [-2500],
      [3000],
    ]);
  });

  it("reads intermediate balances (:60M:/:62M:) and a debit opening balance", () => {
    expect(list[0]!.closingBalance).toMatchObject({
      amount: 15000,
      date: "2024-01-02",
    });
    expect(list[1]!.openingBalance).toMatchObject({
      amount: 15000,
      date: "2024-01-03",
    });
    expect(list[2]!.openingBalance).toMatchObject({
      amount: -1000,
      currency: "CHF",
    });
    for (const s of list) {
      expect(s.openingBalance!.amount + sum(s)).toBe(s.closingBalance!.amount);
    }
  });

  it("parses messages wrapped in SWIFT block headers and trailers", () => {
    const blocks = parse("blocks.sta");
    expect(blocks.map((s) => s.accountIban)).toEqual([IBAN_DE, IBAN_CH]);
    expect(blocks.map((s) => s.transactions[0]!.description)).toEqual([
      "Block one",
      "Block two",
    ]);
    expect(blocks[1]!.transactions[0]!.amount).toBe(-800);
  });
});

describe("opening balance date", () => {
  it("moves a balance struck at the end of a day to the following day", () => {
    const [s] = parse("basic.sta");
    expect(s!.openingBalance!.date).toBe("2024-03-01");
  });

  it("keeps the date when an entry is booked on or before it", () => {
    const [s] = parseMt940(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240301EUR100,00\n:61:240301C1,00NTRFNONREF//B1\n:62F:C240301EUR101,00\n-\n`,
    );
    expect(s!.openingBalance!.date).toBe("2024-03-01");
  });

  it("rolls over a year end", () => {
    const [s] = parseMt940(
      `:20:R\n:25:${IBAN_DE}\n:60F:C241231EUR100,00\n:62F:C241231EUR100,00\n-\n`,
    );
    expect(s!.openingBalance!.date).toBe("2025-01-01");
    expect(s!.closingBalance!.date).toBe("2024-12-31");
  });
});

describe(":61: variants", () => {
  const one = (line: string, info = "") =>
    parseMt940(statement(`${line}${info ? `\n:86:${info}` : ""}`))[0]!
      .transactions;

  it("accepts the entry without the optional entry date", () => {
    const [t] = one(":61:240301C10,00NTRFNONREF//B1");
    expect(t).toMatchObject({
      bookingDate: "2024-03-01",
      valueDate: "2024-03-01",
    });
  });

  it("accepts the funds code and every mark", () => {
    const list = one(
      [
        ":61:240301CR10,00NTRFNONREF//B1",
        ":61:240302DR11,00NTRFNONREF//B2",
        ":61:2403030304RC12,00NTRFNONREF//B3",
        ":61:240304RD13,00NTRFNONREF//B4",
        ":61:240305RCR14,00NTRFNONREF//B5",
      ].join("\n"),
    );
    expect(list.map((t) => [t.amount, t.reversal])).toEqual([
      [1000, false],
      [-1100, false],
      [-1200, true],
      [1300, true],
      [-1400, true],
    ]);
  });

  it("accepts amounts without decimals and with fewer decimals", () => {
    const list = one(
      [":61:240301C10,NTRFNONREF//B1", ":61:240301D1,5NMSCNONREF//B2"].join(
        "\n",
      ),
    );
    expect(list.map((t) => t.amount)).toEqual([1000, -150]);
  });

  it("respects the currency's decimals", () => {
    const [s] = parseMt940(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240229JPY100,\n:61:240301D5,NMSCNONREF//B1\n:62F:C240301JPY95,\n-\n`,
    );
    expect(s!.transactions[0]!.amount).toBe(-5);
    expect(s!.openingBalance!.amount).toBe(100);
  });

  it("accepts the F transaction type and a reference without bank reference", () => {
    const [t] = one(":61:240301C10,00FTRFREF-1");
    expect(t!.externalId).toBe(`cref:REF-1:2024-03-01:1000`);
  });

  it("picks the entry year closest to the value date", () => {
    const [t] = one(":61:2401020102C1,00NTRFNONREF//B1");
    expect(t!.bookingDate).toBe("2024-01-02");
    const [u] = one(":61:2412300103C1,00NTRFNONREF//B2");
    expect(u!.bookingDate).toBe("2025-01-03");
    const [v] = one(":61:2501021230D1,00NMSCNONREF//B3");
    expect(v!.bookingDate).toBe("2024-12-30");
  });

  it("treats two-digit years of 70 and above as 19xx", () => {
    const [t] = one(":61:991231C1,00NTRFNONREF//B1");
    expect(t!.valueDate).toBe("1999-12-31");
  });
});

describe("reversals", () => {
  const [s] = parse("reversal.sta");

  it("flags RC and RD and keeps the direction of the entry", () => {
    expect(s!.transactions.map((t) => [t.amount, t.reversal])).toEqual([
      [20000, false],
      [-8000, true],
      [3000, true],
      [-2000, false],
    ]);
    expect(s!.openingBalance!.amount + sum(s!)).toBe(s!.closingBalance!.amount);
  });

  it("gives a reversal its own id, separate from the original", () => {
    expect(new Set(s!.transactions.map((t) => t.externalId)).size).toBe(4);
  });

  it("keeps the counterparty of a reversal", () => {
    expect(s!.transactions[1]).toMatchObject({
      counterpartyName: "Jane Example",
      counterpartyIban: IBAN_CH,
      description: "Returned credit",
    });
  });

  it("does not collapse a reversal with the entry it reverses", () => {
    const [a, b] = parseMt940(
      statement(
        ":61:240301C5,00NTRFNONREF\n:86:Same text\n:61:240301RC5,00NTRFNONREF\n:86:Same text",
      ),
    )[0]!.transactions;
    expect(a!.externalId).not.toBe(b!.externalId);
  });
});

describe("foreign currency", () => {
  const [s] = parse("foreign.sta");

  it("reads the original amount from /OCMT/ with the direction of the entry", () => {
    expect(s!.transactions[0]).toMatchObject({
      amount: -9235,
      currency: "CHF",
      originalAmount: -10000,
      originalCurrency: "USD",
    });
    expect(s!.transactions[1]).toMatchObject({
      amount: 50000,
      originalAmount: 52000,
      originalCurrency: "EUR",
      description: "Transfer /OCMT/EUR520,00/CHGS/CHF0,00/",
    });
  });

  it("leaves the original empty when it is in the account currency", () => {
    expect(s!.transactions[2]).toMatchObject({
      originalAmount: null,
      originalCurrency: null,
    });
  });
});

describe("references and externalId", () => {
  it("uses the bank reference with date and amount", () => {
    const [t] = parseMt940(statement(":61:240301D9,99NMSCNONREF//BANK-1"))[0]!
      .transactions;
    expect(t!.externalId).toBe("mt940:BANK-1:2024-03-01:-999");
  });

  it("uses EREF+ like camt (end-to-end id, date, amount, party) without a bank reference", () => {
    const [t] = parseMt940(
      statement(
        `:61:240301D9,99NMSCNONREF\n:86:166?20EREF+E2E-77?21SVWZ+x?31${IBAN_CH}`,
      ),
    )[0]!.transactions;
    expect(t!.externalId).toBe(`e2e:E2E-77:2024-03-01:-999:${IBAN_CH}`);
  });

  it("uses the customer reference when nothing better exists", () => {
    const [t] = parseMt940(statement(":61:240301D9,99NMSCCUST-9"))[0]!
      .transactions;
    expect(t!.externalId).toBe("cref:CUST-9:2024-03-01:-999");
  });

  it("treats NONREF and NOTPROVIDED as no reference and hashes the content", () => {
    const [t] = parseMt940(
      statement(
        ":61:240301D9,99NMSCNONREF\n:86:166?20EREF+NOTPROVIDED?21SVWZ+Hello",
      ),
    )[0]!.transactions;
    expect(t!.externalId).toMatch(/^hash:[0-9a-f]{64}$/);
  });

  it("derives the same hash for the same content and another one for other content", () => {
    const a = parseMt940(statement(":61:240301D9,99NMSC\n:86:Hello"))[0]!;
    const b = parseMt940(statement(":61:240301D9,99NMSC\n:86:Hello"))[0]!;
    const c = parseMt940(statement(":61:240301D9,99NMSC\n:86:Other"))[0]!;
    expect(a.transactions[0]!.externalId).toBe(b.transactions[0]!.externalId);
    expect(a.transactions[0]!.externalId).not.toBe(
      c.transactions[0]!.externalId,
    );
  });

  it("hashes independently of the statement reference, number and position", () => {
    const base = ":61:240301D9,99NMSC\n:86:Hello";
    const a = parseMt940(statement(base))[0]!;
    const b = parseMt940(
      `:20:OTHER\n:25:${IBAN_DE}\n:28C:99/9\n:60F:C240229EUR1,00\n:61:240228C1,00NMSC\n${base}\n:62F:C240331EUR1,00\n-\n`,
    )[0]!;
    expect(b.transactions[1]!.externalId).toBe(a.transactions[0]!.externalId);
  });

  it("distinguishes the same booking on different accounts", () => {
    const a = parseMt940(statement(":61:240301D9,99NMSC\n:86:Hello"))[0]!;
    const b = parseMt940(
      statement(":61:240301D9,99NMSC\n:86:Hello").replace(IBAN_DE, IBAN_CH),
    )[0]!;
    expect(a.transactions[0]!.externalId).not.toBe(
      b.transactions[0]!.externalId,
    );
  });

  it("keeps identical bookings apart with an occurrence suffix", () => {
    const [s] = parse("no-optional.sta");
    const ids = s!.transactions.map((t) => t.externalId);
    expect(ids[1]).toMatch(/^cref:|^hash:/);
    expect(ids[2]).toMatch(/^hash:/);
    expect(ids[3]).toBe(`${ids[2]}#2`);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("overlapping files", () => {
  const a = parse("overlap-a.sta")[0]!.transactions;
  const b = parse("overlap-b.sta")[0]!.transactions;

  it("gives the same booking the same externalId, with and without a bank reference", () => {
    expect(a.slice(1).map((t) => t.externalId)).toEqual(
      b.slice(0, 2).map((t) => t.externalId),
    );
    expect(a[1]!.externalId).toMatch(/^hash:/);
    expect(a[2]!.externalId).toBe("mt940:OV002:2024-07-09:-2000");
  });

  it("does not collide on bookings that exist in one file only", () => {
    expect(new Set([...a, ...b].map((t) => t.externalId)).size).toBe(4);
  });
});

describe("missing optional fields", () => {
  const [first, second] = parse("no-optional.sta");

  it("imports entries without :86:, :28C:, :21: and bank reference", () => {
    expect(first!.statementId).toBe("EXAMPLE0004");
    expect(first!.transactions[0]).toMatchObject({
      amount: 1000,
      description: null,
      counterpartyName: null,
      counterpartyIban: null,
      reference: null,
    });
    expect(first!.openingBalance!.amount + sum(first!)).toBe(
      first!.closingBalance!.amount,
    );
  });

  it("allows a statement without opening balance and without entries", () => {
    expect(second).toMatchObject({
      accountIban: IBAN_CH,
      currency: "CHF",
      openingBalance: null,
      transactions: [],
    });
    expect(second!.closingBalance).toMatchObject({
      amount: -1200,
      date: "2024-01-31",
    });
  });

  it("allows an empty statement", () => {
    const [s] = parse("empty.sta");
    expect(s).toMatchObject({ transactions: [], statementId: "00009/001" });
    expect(s!.openingBalance!.amount).toBe(4200);
    expect(s!.closingBalance!.amount).toBe(4200);
  });

  it("takes the currency from :25: when there are no balances", () => {
    const [s] = parseMt940(`:20:R\n:25:${IBAN_CH}/CHF\n-\n`);
    expect(s).toMatchObject({ currency: "CHF", accountIban: IBAN_CH });
  });

  it("keeps a local account number as the other id", () => {
    const [s] = parseMt940(
      `:20:R\n:25:12345678/0532013000\n:60F:C240101EUR1,00\n:62F:C240101EUR1,00\n-\n`,
    );
    expect(s).toMatchObject({
      accountIban: null,
      accountOtherId: "12345678/0532013000",
    });
  });

  it("strips a currency suffix from a local account number", () => {
    const [s] = parseMt940(
      `:20:R\n:25:0532013000/EUR\n:62F:C240101EUR1,00\n-\n`,
    );
    expect(s).toMatchObject({
      accountIban: null,
      accountOtherId: "0532013000",
    });
  });
});

describe("line endings and character sets", () => {
  const lf = load("basic.sta");
  const expected = parseMt940(lf);

  it("parses CRLF and CR like LF", () => {
    expect(parseMt940(lf.replace(/\n/g, "\r\n"))).toEqual(expected);
    expect(parseMt940(lf.replace(/\n/g, "\r"))).toEqual(expected);
  });

  it("does not need the trailing terminator or a final newline", () => {
    expect(parseMt940(lf.replace(/-\n$/, "").trimEnd())).toEqual(expected);
  });

  it("skips a byte order mark and blank lines", () => {
    expect(parseMt940(`\uFEFF\n${lf.replace(/\n/g, "\n\n")}`)).toEqual(
      expected,
    );
  });

  it("decodes a windows-1252 file through the shared text decoder", () => {
    const raw = bytes("latin1.sta");
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ).toThrow();
    const [s] = parseMt940(decodeText(raw));
    expect(s!.transactions[0]).toMatchObject({
      description: "Café Müller\u2013Rechnung",
      counterpartyName: "Grüße & Söhne GmbH",
    });
  });

  it("decodes UTF-8 and UTF-16 as well", () => {
    const text = load("latin1.sta");
    const utf8 = new TextEncoder().encode(text);
    expect(parseMt940(decodeText(utf8))[0]!.transactions[0]!.description).toBe(
      "Café Müller\u2013Rechnung",
    );
    const utf16 = new Uint8Array([0xff, 0xfe, ...utf16le(text)]);
    expect(parseMt940(decodeText(utf16))[0]!.transactions[0]!.description).toBe(
      "Café Müller\u2013Rechnung",
    );
  });
});

function utf16le(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out.push(c & 0xff, c >> 8);
  }
  return out;
}

describe("malformed input", () => {
  it("rejects empty files", () => bad("  \n", /Empty file/));

  it("rejects XML", () =>
    bad("<?xml version='1.0'?><Document/>", /looks like XML/));

  it("rejects text without a :20: field", () =>
    bad("hello world\n", /no :20: statement field|outside of any field/));

  it("rejects a tag before the first :20:", () =>
    bad(`:25:${IBAN_DE}\n:20:R\n`, /Line 1: field :25: appears before/));

  it("rejects stray text outside of a field", () =>
    bad(`junk\n:20:R\n`, /Line 1: text outside of any field/));

  it("rejects a statement without account", () =>
    bad(":20:R\n:60F:C240101EUR1,00\n-\n", /Statement #1 has no account/));

  it("rejects a second :25:", () =>
    bad(`:20:R\n:25:${IBAN_DE}\n:25:${IBAN_CH}\n`, /more than one :25:/));

  it("rejects a statement whose currency cannot be determined", () =>
    bad(`:20:R\n:25:${IBAN_DE}\n-\n`, /cannot determine the account currency/));

  it("rejects different currencies in opening and closing balance", () =>
    bad(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240101EUR1,00\n:62F:C240101CHF1,00\n-\n`,
      /different currencies/,
    ));

  it("rejects a malformed balance", () => {
    bad(
      `:20:R\n:25:${IBAN_DE}\n:60F:X240101EUR1,00\n-\n`,
      /:60:.*malformed balance/,
    );
    bad(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240101EUR1.00\n-\n`,
      /:60:.*malformed balance/,
    );
    bad(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240231EUR1,00\n-\n`,
      /not a calendar date/,
    );
  });

  it("rejects a missing or unknown debit/credit mark instead of guessing", () => {
    bad(statement(":61:240301 10,00NTRFNONREF"), /:61: .*malformed entry/);
    bad(statement(":61:240301X10,00NTRFNONREF"), /:61: .*malformed entry/);
    bad(statement(":61:240301EC10,00NTRFNONREF"), /:61: .*malformed entry/);
  });

  it("rejects negative amounts and a decimal point", () => {
    bad(statement(":61:240301C-10,00NTRFNONREF"), /malformed entry/);
    bad(statement(":61:240301C10.00NTRFNONREF"), /malformed entry/);
  });

  it("rejects amounts with too many decimals for the currency", () =>
    bad(statement(":61:240301C10,005NTRFNONREF"), /more decimals than EUR/));

  it("rejects an invalid date", () => {
    bad(statement(":61:240231C10,00NTRFNONREF"), /not a calendar date/);
    bad(statement(":61:2403011331C10,00NTRFNONREF"), /not a calendar date/);
  });

  it("rejects a malformed OCMT amount", () =>
    bad(
      statement(":61:240301C10,00NTRFNONREF\n:86:x /OCMT/USD1,005/"),
      /more decimals than USD/,
    ));

  it("rejects :86: without a preceding :61:", () =>
    bad(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240101EUR1,00\n:86:text\n-\n`,
      /:86: without a preceding :61:/,
    ));

  it("rejects an :61: after the closing balance", () =>
    bad(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240101EUR1,00\n:62F:C240101EUR1,00\n:61:240101C1,00NTRFNONREF\n-\n`,
      /after the closing balance/,
    ));

  it("does not return a partial result when a later statement is bad", () => {
    bad(
      `${statement(":61:240301C1,00NTRFNONREF//B1")}:20:R2\n:25:${IBAN_DE}\n:60F:C240101EUR1,00\n:61:garbage\n-\n`,
      /Statement #2 :61: \(line \d+\): malformed entry/,
    );
  });

  it("does not echo the content of the bad field", () => {
    try {
      parseMt940(statement(":61:240301XSECRET-TEXT10,00NTRFNONREF"));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET");
    }
  });
});
