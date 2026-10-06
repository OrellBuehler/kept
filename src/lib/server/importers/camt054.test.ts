import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCamt053 } from "./camt053";
import { parseCamt054 } from "./camt054";
import {
  IBAN_CH,
  IBAN_DE,
  IBAN_GB,
  IBAN_QR,
  REF_SCOR_ISO_EXAMPLE,
} from "../../testing/fixtures/camt053/examples";
import { ImportFormatError } from "./types";

const fixtures = join(import.meta.dirname, "../../testing/fixtures");
const load = (name: string) => readFileSync(join(fixtures, name), "utf8");
const parse = (name: string) => parseCamt054(load(`camt054/${name}`));

function wrap(body: string, ns = "camt.054.001.04") {
  return `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:${ns}"><BkToCstmrDbtCdtNtfctn>${body}</BkToCstmrDbtCdtNtfctn></Document>`;
}

function ntfctn(entries: string) {
  return wrap(
    `<Ntfctn><Id>N</Id><Acct><Id><IBAN>${IBAN_CH}</IBAN></Id><Ccy>CHF</Ccy></Acct>${entries}</Ntfctn>`,
  );
}

function ntry(amt: string, ind: string, extra = "") {
  return `<Ntry><Amt Ccy="CHF">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2024-01-02</Dt></BookgDt>${extra}</Ntry>`;
}

describe("camt.054.001.02", () => {
  const [n] = parse("v02-basic.xml");

  it("reads the account, period and entries; no balances are invented", () => {
    expect(n!.accountIban).toBe(IBAN_CH);
    expect(n!.currency).toBe("CHF");
    expect(n!.statementId).toBe("NTF-V02-1");
    expect(n!.fromDate).toBe("2024-05-06");
    expect(n!.toDate).toBe("2024-05-07");
    expect(n!.openingBalance).toBeNull();
    expect(n!.closingBalance).toBeNull();
    expect(n!.transactions).toHaveLength(2);
  });

  it("signs from the indicator and reads parties and references", () => {
    const [credit, debit] = n!.transactions;
    expect(credit).toMatchObject({
      externalId: "acsr:V02-REF-1",
      bookingDate: "2024-05-06",
      valueDate: "2024-05-06",
      amount: 15000,
      currency: "CHF",
      counterpartyName: "Jane Example",
      counterpartyIban: IBAN_DE,
      reference: "210000000003139471430009017",
      referenceType: "QRR",
      reversal: false,
    });
    expect(debit).toMatchObject({
      externalId: "acsr:V02-REF-2",
      valueDate: "2024-05-08",
      amount: -4510,
      counterpartyName: "Sample Insurance AG",
      counterpartyIban: IBAN_QR,
      description: "Premium May",
    });
  });
});

describe("camt.054.001.04", () => {
  const [n] = parse("v04-basic.xml");

  it("imports booked entries only and keeps zero amounts", () => {
    expect(n!.transactions.map((t) => t.amount)).toEqual([120000, 0, -1990]);
    expect(n!.transactions.map((t) => t.externalId)).toEqual([
      "acsr:V04-REF-1",
      "acsr:V04-REF-2",
      "acsr:V04-REF-3",
    ]);
  });

  it("has no declared period and no balances", () => {
    expect(n).toMatchObject({
      fromDate: null,
      toDate: null,
      openingBalance: null,
      closingBalance: null,
    });
  });

  it("reads the description from the remittance information", () => {
    expect(n!.transactions[0]!.description).toBe("Salary June");
    expect(n!.transactions[1]!.description).toBe("Account fee waived");
  });
});

describe("camt.054.001.08", () => {
  const [n] = parse("v08-basic.xml");

  it("reads Sts/Cd, DtTm booking dates and Pty/Nm names", () => {
    expect(n!.accountIban).toBe(IBAN_DE);
    expect(n!.currency).toBe("EUR");
    const [credit, debit] = n!.transactions;
    expect(credit).toMatchObject({
      externalId: "acsr:V08-REF-1",
      bookingDate: "2024-06-28",
      valueDate: "2024-06-28",
      amount: 250000,
      counterpartyName: "Example Employer AG",
      counterpartyIban: IBAN_CH,
      description: "Invoice 2024-17",
    });
    expect(debit).toMatchObject({
      amount: -8990,
      counterpartyName: "Example Energy Ltd",
      counterpartyIban: IBAN_GB,
      reference: REF_SCOR_ISO_EXAMPLE,
      referenceType: "SCOR",
    });
  });

  it("accepts a later version through the same code path", () => {
    const xml = load("camt054/v08-basic.xml").replace(
      "camt.054.001.08",
      "camt.054.001.12",
    );
    expect(parseCamt054(xml)[0]!.transactions).toHaveLength(2);
  });
});

describe("batched entries", () => {
  const [n] = parse("batch.xml");

  it("splits an entry whose TxDtls amounts sum to the entry amount", () => {
    const split = n!.transactions.slice(0, 3);
    expect(split.map((t) => t.amount)).toEqual([10000, 12000, 8000]);
    expect(split.map((t) => t.counterpartyName)).toEqual([
      "Jane Example",
      "Example Energy Ltd",
      "Sample Insurance AG",
    ]);
    expect(split.map((t) => t.externalId)).toEqual([
      "acsr:BATCH-SPLIT/a:BATCH-SPLIT-A",
      "acsr:BATCH-SPLIT/e:E2E-B",
      "acsr:BATCH-SPLIT/i:2",
    ]);
    expect(split.reduce((s, t) => s + t.amount, 0)).toBe(30000);
  });

  it("keeps ambiguous batches as one transaction without per-detail data", () => {
    const whole = n!.transactions[3]!;
    expect(n!.transactions).toHaveLength(4);
    expect(whole).toMatchObject({
      amount: -25000,
      externalId: "acsr:BATCH-NOSPLIT",
    });
    expect(whole.counterpartyName).toBeNull();
  });
});

describe("reversals", () => {
  const [n] = parse("reversal.xml");

  it("flags reversals and keeps the sign of the reversal entry", () => {
    expect(n!.transactions.map((t) => [t.amount, t.reversal])).toEqual([
      [20000, false],
      [-8000, true],
      [3000, true],
    ]);
  });

  it("reads the original counterparty from the opposite role", () => {
    const [, returned, cancelled] = n!.transactions;
    expect(returned!.counterpartyName).toBe("Example Energy Ltd");
    expect(returned!.counterpartyIban).toBe(IBAN_GB);
    expect(cancelled!.counterpartyName).toBe("Sample Insurance AG");
    expect(cancelled!.counterpartyIban).toBe(IBAN_QR);
  });
});

describe("foreign currency", () => {
  const [n] = parse("foreign-currency.xml");

  it("keeps the booked amount and the original instructed or transaction amount", () => {
    const [instructed, transactionAmt, instructedSame] = n!.transactions;
    expect(instructed).toMatchObject({
      amount: -9235,
      currency: "CHF",
      originalAmount: -10000,
      originalCurrency: "USD",
    });
    expect(transactionAmt).toMatchObject({
      amount: 50000,
      originalAmount: 52000,
      originalCurrency: "EUR",
    });
    expect(instructedSame).toMatchObject({
      amount: -3500,
      originalAmount: -3000,
      originalCurrency: "GBP",
    });
  });

  it("leaves the original amount empty when the currency is the same", () => {
    const [m] = parseCamt054(
      ntfctn(
        ntry(
          "10.00",
          "DBIT",
          `<NtryDtls><TxDtls><AmtDtls><InstdAmt><Amt Ccy="CHF">10.00</Amt></InstdAmt></AmtDtls></TxDtls></NtryDtls>`,
        ),
      ),
    );
    expect(m!.transactions[0]).toMatchObject({
      originalAmount: null,
      originalCurrency: null,
    });
  });
});

describe("missing references", () => {
  const [n] = parse("no-refs.xml");

  it("falls back to a content hash", () => {
    for (const t of n!.transactions) expect(t.externalId).toMatch(/^hash:/);
  });

  it("keeps identical bookings apart with an occurrence suffix", () => {
    const ids = n!.transactions.map((t) => t.externalId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe(`${ids[0]}#2`);
  });

  it("derives the same hash in every parse", () => {
    expect(
      parse("no-refs.xml")[0]!.transactions.map((t) => t.externalId),
    ).toEqual(n!.transactions.map((t) => t.externalId));
  });

  it("uses the end-to-end id with date, amount and party when there is no servicer reference", () => {
    const [m] = parseCamt054(
      ntfctn(
        ntry(
          "10.00",
          "DBIT",
          `<NtryDtls><TxDtls><Refs><EndToEndId>E2E-9</EndToEndId></Refs><RltdPties><Cdtr><Nm>Jane Example</Nm></Cdtr><CdtrAcct><Id><IBAN>${IBAN_DE}</IBAN></Id></CdtrAcct></RltdPties></TxDtls></NtryDtls>`,
        ),
      ),
    );
    expect(m!.transactions[0]!.externalId).toBe(
      `e2e:E2E-9:2024-01-02:-1000:${IBAN_DE}`,
    );
  });
});

describe("overlapping files", () => {
  const a = parse("overlap-a.xml")[0]!.transactions;
  const b = parse("overlap-b.xml")[0]!.transactions;

  it("gives the same booking the same externalId, with and without a reference", () => {
    expect(a.map((t) => t.externalId).slice(1)).toEqual(
      b.map((t) => t.externalId).slice(0, 2),
    );
    expect(a[1]!.externalId).toMatch(/^hash:/);
    expect(a[2]!.externalId).toBe("acsr:OVN-02");
  });

  it("does not collide on bookings that only exist in one file", () => {
    const all = new Set([...a, ...b].map((t) => t.externalId));
    expect(all.size).toBe(4);
  });

  it("matches the camt.053 id of the same booking", () => {
    const stmt = parseCamt053(load("camt053/overlap-a.xml"))[0]!.transactions;
    const note = parse("same-as-camt053.xml")[0]!.transactions;
    expect(note[0]!.externalId).toBe("acsr:OV-01");
    expect(note[0]!.externalId).toBe(stmt[0]!.externalId);
    expect(note[1]!.externalId).toMatch(/^hash:/);
    expect(note[1]!.externalId).toBe(stmt[3]!.externalId);
  });
});

describe("several accounts and notifications", () => {
  it("returns one statement per notification, in file order", () => {
    const list = parse("multi-account.xml");
    expect(list.map((s) => s.accountIban)).toEqual([IBAN_CH, IBAN_DE, IBAN_CH]);
    expect(list.map((s) => s.currency)).toEqual(["CHF", "EUR", "CHF"]);
    expect(list.map((s) => s.transactions[0]!.amount)).toEqual([
      1000, -2000, -550,
    ]);
  });
});

describe("empty notifications", () => {
  it("returns a statement without transactions", () => {
    const [n] = parse("empty-notification.xml");
    expect(n).toMatchObject({
      accountIban: IBAN_CH,
      currency: "CHF",
      transactions: [],
      openingBalance: null,
      closingBalance: null,
    });
  });

  it("takes the currency from the first entry when the account has none", () => {
    const [n] = parseCamt054(
      wrap(
        `<Ntfctn><Id>N</Id><Acct><Id><IBAN>${IBAN_CH}</IBAN></Id></Acct>${ntry("1.00", "CRDT")}</Ntfctn>`,
      ),
    );
    expect(n!.currency).toBe("CHF");
  });
});

describe("account identification", () => {
  it("accepts a non-IBAN account id", () => {
    const [n] = parseCamt054(
      wrap(
        `<Ntfctn><Id>N</Id><Acct><Id><Othr><Id>12-345-6</Id></Othr></Id><Ccy>CHF</Ccy></Acct></Ntfctn>`,
      ),
    );
    expect(n).toMatchObject({ accountIban: null, accountOtherId: "12-345-6" });
  });
});

describe("malformed input", () => {
  const bad = (xml: string, message: RegExp) => {
    expect(() => parseCamt054(xml)).toThrow(ImportFormatError);
    expect(() => parseCamt054(xml)).toThrow(message);
  };

  it("rejects empty files", () => bad("  ", /Empty file.*camt\.054/));

  it("rejects XML that is not well formed", () =>
    bad("<Document><BkToCstmrDbtCdtNtfctn>", /Invalid XML/));

  it("rejects other message types by namespace", () => {
    bad(
      load("camt053/v04-basic.xml"),
      /Not a camt\.054 file: found camt\.053\.001\.04/,
    );
  });

  it("rejects a camt.053 container below a camt.054 namespace", () => {
    bad(
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.04"><BkToCstmrStmt/></Document>`,
      /no BkToCstmrDbtCdtNtfctn element/,
    );
  });

  it("rejects a file without notifications", () =>
    bad(wrap("<GrpHdr><MsgId>X</MsgId></GrpHdr>"), /no notifications/));

  it("rejects DOCTYPE and ENTITY declarations", () =>
    bad(
      `<!DOCTYPE x [<!ENTITY a "b">]>${ntfctn(ntry("1.00", "CRDT"))}`,
      /DOCTYPE and ENTITY/,
    ));

  it("rejects a notification without an account", () =>
    bad(
      wrap(`<Ntfctn><Id>N</Id>${ntry("1.00", "CRDT")}</Ntfctn>`),
      /Ntfctn #1 has no account identification/,
    ));

  it("rejects an invalid credit/debit indicator", () =>
    bad(ntfctn(ntry("1.00", "XXXX")), /CdtDbtInd must be CRDT or DBIT/));

  it("rejects a missing credit/debit indicator instead of guessing the sign", () =>
    bad(
      ntfctn(
        `<Ntry><Amt Ccy="CHF">1.00</Amt><Sts>BOOK</Sts><BookgDt><Dt>2024-01-02</Dt></BookgDt></Ntry>`,
      ),
      /CdtDbtInd must be CRDT or DBIT/,
    ));

  it("rejects negative and malformed amounts", () => {
    bad(ntfctn(ntry("-5.00", "CRDT")), /invalid amount "-5\.00"/);
    bad(ntfctn(ntry("1,50", "CRDT")), /invalid amount "1,50"/);
  });

  it("rejects an entry without a booking date or status", () => {
    bad(
      ntfctn(
        `<Ntry><Amt Ccy="CHF">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts></Ntry>`,
      ),
      /Ntry #1 has no booking date/,
    );
    bad(
      ntfctn(
        `<Ntry><Amt Ccy="CHF">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2024-01-02</Dt></BookgDt></Ntry>`,
      ),
      /Ntry #1 has no status/,
    );
  });

  it("rejects an invalid calendar date and a missing currency", () => {
    bad(
      ntfctn(
        `<Ntry><Amt Ccy="CHF">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2024-02-31</Dt></BookgDt></Ntry>`,
      ),
      /Invalid Ntry #1 booking date "2024-02-31"/,
    );
    bad(
      ntfctn(
        `<Ntry><Amt>1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2024-01-02</Dt></BookgDt></Ntry>`,
      ),
      /missing or invalid currency/,
    );
  });

  it("does not return a partial result when a later entry is bad", () => {
    bad(
      ntfctn(ntry("1.00", "CRDT") + ntry("2.00", "NOPE")),
      /Ntry #2: CdtDbtInd/,
    );
  });
});
