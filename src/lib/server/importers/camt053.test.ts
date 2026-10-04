import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCamt053 } from "./camt053";
import {
  IBAN_CH,
  IBAN_DE,
  IBAN_GB,
  IBAN_QR,
  REF_SCOR_BAD_CHECK,
  REF_SCOR_ISO_EXAMPLE,
} from "../../testing/fixtures/camt053/examples";
import { ImportFormatError, type NormalizedStatement } from "./types";

const dir = join(import.meta.dirname, "../../testing/fixtures/camt053");
const load = (name: string) => readFileSync(join(dir, name), "utf8");
const parse = (name: string) => parseCamt053(load(name));

function sum(s: NormalizedStatement): number {
  return s.transactions.reduce((acc, t) => acc + t.amount, 0);
}

function expectReconciles(s: NormalizedStatement) {
  expect(s.openingBalance).not.toBeNull();
  expect(s.closingBalance).not.toBeNull();
  expect(s.openingBalance!.amount + sum(s)).toBe(s.closingBalance!.amount);
}

function wrap(body: string, ns = "camt.053.001.04") {
  return `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:${ns}"><BkToCstmrStmt>${body}</BkToCstmrStmt></Document>`;
}

function stmt(
  entries: string,
  acct = "<Id><IBAN>" + IBAN_CH + "</IBAN></Id><Ccy>CHF</Ccy>",
) {
  return wrap(`<Stmt><Id>S</Id><Acct>${acct}</Acct>${entries}</Stmt>`);
}

function ntry(amt: string, ind = "CHF", extra = "", ccy = "CHF") {
  return `<Ntry><Amt Ccy="${ccy}">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2024-01-02</Dt></BookgDt>${extra}</Ntry>`;
}

describe("camt.053.001.04", () => {
  const [s] = parse("v04-basic.xml");

  it("reads account, statement metadata and balances", () => {
    expect(parse("v04-basic.xml")).toHaveLength(1);
    expect(s!.accountIban).toBe(IBAN_CH);
    expect(s!.accountOtherId).toBeNull();
    expect(s!.currency).toBe("CHF");
    expect(s!.statementId).toBe("STMT-2024-03");
    expect(s!.fromDate).toBe("2024-03-01");
    expect(s!.toDate).toBe("2024-03-31");
    expect(s!.openingBalance).toEqual({
      amount: 100000,
      currency: "CHF",
      date: "2024-03-01",
    });
    expect(s!.closingBalance).toEqual({
      amount: 233145,
      currency: "CHF",
      date: "2024-03-31",
    });
  });

  it("signs amounts from the indicator and reconciles with the balances", () => {
    expect(s!.transactions.map((t) => t.amount)).toEqual([
      150000, -12345, 0, -4510,
    ]);
    expectReconciles(s!);
  });

  it("reads entry fields", () => {
    const [credit, debit, zero, insurance] = s!.transactions;
    expect(credit).toMatchObject({
      bookingDate: "2024-03-04",
      valueDate: "2024-03-04",
      currency: "CHF",
      counterpartyName: "Jane Example",
      counterpartyIban: IBAN_DE,
      description: "Invoice 2024-001 March consulting",
      reference: null,
      referenceType: null,
      originalAmount: null,
      originalCurrency: null,
      reversal: false,
      externalId: "acsr:EXREF-0001",
    });
    expect(debit).toMatchObject({
      valueDate: "2024-03-11",
      counterpartyName: "Example Energy Ltd",
      counterpartyIban: IBAN_GB,
    });
    expect(zero).toMatchObject({
      amount: 0,
      description: "Account fee waived",
      counterpartyName: null,
    });
    expect(Object.is(zero!.amount, 0)).toBe(true);
    expect(insurance!.description).toBe("Premium Q1");
  });
});

describe("camt.053.001.08", () => {
  const [s] = parse("v08-basic.xml");

  it("reads Sts/Cd, Pty/Nm and DtTm dates", () => {
    expect(s!.accountIban).toBe(IBAN_DE);
    expect(s!.currency).toBe("EUR");
    expect(s!.fromDate).toBe("2024-04-01");
    expect(s!.openingBalance).toEqual({
      amount: 25000,
      currency: "EUR",
      date: "2024-04-01",
    });
    expect(s!.closingBalance!.date).toBe("2024-04-30");
    expect(s!.transactions).toHaveLength(2);
    expect(s!.transactions[0]).toMatchObject({
      bookingDate: "2024-04-02",
      valueDate: "2024-04-02",
      amount: 100000,
      counterpartyName: "Jane Example",
      counterpartyIban: IBAN_CH,
      description: "Refund order 77",
      externalId: "acsr:V8-REF-0001",
    });
    expect(s!.transactions[1]).toMatchObject({
      amount: -11950,
      counterpartyName: "Example Energy Ltd",
    });
    expectReconciles(s!);
  });

  it("works with a namespace prefix", () => {
    const xml = load("v08-basic.xml")
      .replace(/<(\/?)(?!\?)/g, "<$1p:")
      .replace("<p:Document xmlns=", "<p:Document xmlns:p=");
    const [p] = parseCamt053(xml);
    expect(p!.transactions.map((t) => t.amount)).toEqual([100000, -11950]);
  });
});

describe("camt.053.001.02", () => {
  it("reads plain Sts and a negative (overdrawn) closing balance", () => {
    const [s] = parse("v02-basic.xml");
    expect(s!.openingBalance!.amount).toBe(10000);
    expect(s!.closingBalance!.amount).toBe(-15000);
    expect(s!.transactions).toHaveLength(1);
    expect(s!.transactions[0]).toMatchObject({
      amount: -25000,
      counterpartyName: "Sample Insurance AG",
      description: "Policy 4711",
    });
    expectReconciles(s!);
  });

  it("degrades gracefully for other camt.053.001.NN versions", () => {
    const xml = load("v04-basic.xml").replace(
      "camt.053.001.04",
      "camt.053.001.13",
    );
    expect(parseCamt053(xml)[0]!.transactions).toHaveLength(4);
  });
});

describe("multiple accounts", () => {
  const statements = parse("multi-account.xml");

  it("returns one statement per Stmt", () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({
      accountIban: IBAN_CH,
      currency: "CHF",
      statementId: "STMT-CHF-1",
    });
    expect(statements[1]).toMatchObject({
      accountIban: IBAN_DE,
      currency: "EUR",
      statementId: "STMT-EUR-1",
    });
  });

  it("keeps transactions with their own statement", () => {
    expect(
      statements[0]!.transactions.map((t) => [t.currency, t.amount]),
    ).toEqual([["CHF", 5000]]);
    expect(
      statements[1]!.transactions.map((t) => [t.currency, t.amount]),
    ).toEqual([["EUR", -3000]]);
    statements.forEach(expectReconciles);
  });
});

describe("account identification and currency", () => {
  it("uses Othr/Id when there is no IBAN", () => {
    const [s] = parseCamt053(
      stmt(
        ntry("1.00", "CRDT"),
        "<Id><Othr><Id>ACC-0042</Id></Othr></Id><Ccy>EUR</Ccy>",
      ),
    );
    expect(s).toMatchObject({
      accountIban: null,
      accountOtherId: "ACC-0042",
      currency: "EUR",
    });
  });

  it("derives the currency from balances, then from entries", () => {
    const bal = `<Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2024-01-01</Dt></Dt></Bal>`;
    const acct = "<Id><IBAN>" + IBAN_CH + "</IBAN></Id>";
    const [fromBal] = parseCamt053(stmt(bal, acct));
    expect(fromBal!.currency).toBe("EUR");
    expect(fromBal!.openingBalance!.amount).toBe(500);
    const [fromEntry] = parseCamt053(
      stmt(ntry("1.00", "CRDT", "", "USD"), acct),
    );
    expect(fromEntry!.currency).toBe("USD");
  });

  it("rejects a statement without account id", () => {
    expect(() =>
      parseCamt053(stmt(ntry("1.00", "CRDT"), "<Ccy>CHF</Ccy>")),
    ).toThrow(/account identification/);
  });

  it("rejects a statement without any currency", () => {
    expect(() =>
      parseCamt053(stmt("", "<Id><IBAN>" + IBAN_CH + "</IBAN></Id>")),
    ).toThrow(/currency/);
  });
});

describe("amounts", () => {
  it("respects the minor-unit exponent of the currency", () => {
    const acct = "<Id><IBAN>" + IBAN_CH + "</IBAN></Id>";
    const [s] = parseCamt053(
      stmt(
        ntry("1500", "CRDT", "", "JPY") +
          ntry("1.234", "DBIT", "", "KWD") +
          ntry("10.5", "CRDT", "", "EUR") +
          ntry("7.00", "CRDT", "", "JPY"),
        acct,
      ),
    );
    expect(s!.transactions.map((t) => [t.currency, t.amount])).toEqual([
      ["JPY", 1500],
      ["KWD", -1234],
      ["EUR", 1050],
      ["JPY", 7],
    ]);
  });

  it("rejects negative, malformed and over-precise amounts", () => {
    expect(() => parseCamt053(stmt(ntry("-5.00", "CRDT")))).toThrow(
      ImportFormatError,
    );
    expect(() => parseCamt053(stmt(ntry("abc", "CRDT")))).toThrow(
      /invalid amount/,
    );
    expect(() => parseCamt053(stmt(ntry("1.005", "CRDT")))).toThrow(/decimals/);
  });

  it("rejects a bad indicator instead of guessing the sign", () => {
    expect(() => parseCamt053(stmt(ntry("5.00", "XXXX")))).toThrow(/CdtDbtInd/);
    expect(() => parseCamt053(stmt(ntry("5.00", "")))).toThrow(/CdtDbtInd/);
  });
});

describe("entry status", () => {
  it("imports only booked entries", () => {
    const [s] = parse("pending.xml");
    expect(s!.transactions.map((t) => t.externalId)).toEqual([
      "acsr:PD-1",
      "acsr:PD-4",
    ]);
  });

  it("skips PDNG in the .08 Sts/Cd form", () => {
    const pending = ntry("5.00", "DBIT").replace(
      "<Sts>BOOK</Sts>",
      "<Sts><Cd>PDNG</Cd></Sts>",
    );
    const [s] = parseCamt053(stmt(pending + ntry("6.00", "DBIT"), undefined));
    expect(s!.transactions).toHaveLength(1);
    expect(s!.transactions[0]!.amount).toBe(-600);
  });

  it("rejects an entry without booking date or status", () => {
    expect(() =>
      parseCamt053(
        stmt(ntry("1.00", "CRDT").replace(/<BookgDt>.*<\/BookgDt>/, "")),
      ),
    ).toThrow(/booking date/);
    expect(() =>
      parseCamt053(stmt(ntry("1.00", "CRDT").replace("<Sts>BOOK</Sts>", ""))),
    ).toThrow(/status/);
  });
});

describe("empty statement", () => {
  it("yields a statement with no transactions", () => {
    const [s] = parse("empty-statement.xml");
    expect(s!.transactions).toEqual([]);
    expect(s!.openingBalance!.amount).toBe(7500);
    expect(s!.closingBalance!.amount).toBe(7500);
  });

  it("rejects a file without any Stmt", () => {
    expect(() =>
      parseCamt053(wrap("<GrpHdr><MsgId>X</MsgId></GrpHdr>")),
    ).toThrow(/no statements/);
  });
});

describe("reversals", () => {
  const [s] = parse("reversal.xml");

  it("takes the sign from the indicator and flags the reversal", () => {
    expect(s!.transactions.map((t) => [t.amount, t.reversal])).toEqual([
      [20000, false],
      [-8000, true],
      [3000, true],
    ]);
    expectReconciles(s!);
  });

  it("uses the original operation's role, falling back to the other", () => {
    const only = (role: string, ind: string) =>
      parseCamt053(
        stmt(
          ntry(
            "5.00",
            ind,
            `<RvslInd>true</RvslInd><NtryDtls><TxDtls><RltdPties><${role}><Nm>Somebody</Nm></${role}></RltdPties></TxDtls></NtryDtls>`,
          ),
        ),
      )[0]!.transactions[0]!;
    expect(only("Cdtr", "CRDT").counterpartyName).toBe("Somebody");
    expect(only("Dbtr", "CRDT").counterpartyName).toBe("Somebody");
    expect(only("Dbtr", "DBIT").counterpartyName).toBe("Somebody");
    expect(only("Cdtr", "DBIT").counterpartyName).toBe("Somebody");
  });

  it("reads the counterparty of the reversed payment", () => {
    expect(s!.transactions[1]).toMatchObject({
      counterpartyName: "Example Energy Ltd",
      counterpartyIban: IBAN_GB,
    });
    expect(s!.transactions[2]).toMatchObject({
      counterpartyName: "Sample Insurance AG",
      counterpartyIban: IBAN_QR,
    });
  });

  it("does not fall back to the other role for normal entries", () => {
    const [n] = parseCamt053(
      stmt(
        ntry(
          "5.00",
          "CRDT",
          "<NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Account Holder</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>",
        ),
      ),
    );
    expect(n!.transactions[0]!.counterpartyName).toBeNull();
  });
});

describe("foreign currency", () => {
  const [s] = parse("foreign-currency.xml");

  it("fills the original amount from InstdAmt or TxAmt", () => {
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
    });
  });

  it("leaves it empty when the currency is the same", () => {
    expect(s!.transactions[2]).toMatchObject({
      originalAmount: null,
      originalCurrency: null,
    });
  });
});

describe("batch entries", () => {
  const [s] = parse("batch.xml");

  it("splits when TxDtls amounts sum to the entry amount", () => {
    const split = s!.transactions.slice(0, 3);
    expect(split.map((t) => t.amount)).toEqual([10000, 12000, 8000]);
    expect(split.map((t) => t.counterpartyName)).toEqual([
      "Jane Example",
      "Example Energy Ltd",
      "Sample Insurance AG",
    ]);
    expect(split[1]).toMatchObject({
      reference: REF_SCOR_ISO_EXAMPLE,
      referenceType: "SCOR",
    });
    expect(split.every((t) => t.bookingDate === "2024-11-05")).toBe(true);
  });

  it("derives split ids from TxDtls references, else position", () => {
    expect(s!.transactions.slice(0, 3).map((t) => t.externalId)).toEqual([
      "acsr:BATCH-SPLIT/a:BATCH-SPLIT-A",
      "acsr:BATCH-SPLIT/e:E2E-B",
      "acsr:BATCH-SPLIT/i:2",
    ]);
  });

  it("keeps one transaction when amounts do not sum up", () => {
    expect(s!.transactions[3]).toMatchObject({
      externalId: "acsr:BATCH-NOSPLIT",
      amount: -25000,
      description: "Salary run November",
      counterpartyName: null,
    });
  });

  it("keeps one transaction when TxDtls have no amounts", () => {
    expect(s!.transactions[4]).toMatchObject({
      externalId: "acsr:BATCH-NOAMT",
      amount: -7000,
      counterpartyName: null,
    });
    expect(s!.transactions).toHaveLength(5);
  });

  it("keeps the booked total across the split", () => {
    expect(sum(s!)).toBe(30000 - 25000 - 7000);
  });
});

describe("structured references", () => {
  const [s] = parse("qr-reference.xml");
  const refs = s!.transactions.map((t) => [t.reference, t.referenceType]);

  it("reads declared types and strips spaces", () => {
    expect(refs[0]).toEqual(["210000000003139471430009017", "QRR"]);
    expect(refs[1]).toEqual(["RF302024INV0042", "SCOR"]);
  });

  it("detects the type by shape when Tp is missing", () => {
    expect(refs[2]).toEqual(["000000000000000000000001236", "QRR"]);
    expect(refs[3]).toEqual([REF_SCOR_ISO_EXAMPLE, "SCOR"]);
  });

  it("keeps an unrecognized reference without a type", () => {
    expect(refs[4]).toEqual(["ABC-123", null]);
  });

  it("does not detect references with a wrong check digit", () => {
    const ref = (r: string) =>
      parseCamt053(
        stmt(
          ntry(
            "1.00",
            "CRDT",
            `<NtryDtls><TxDtls><RmtInf><Strd><CdtrRefInf><Ref>${r}</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls>`,
          ),
        ),
      )[0]!.transactions[0]!;
    expect(ref("210000000003139471430009018").referenceType).toBeNull();
    expect(ref(REF_SCOR_BAD_CHECK).referenceType).toBeNull();
  });

  it("uses the QR-IBAN account", () => {
    expect(s!.accountIban).toBe(IBAN_QR);
  });
});

describe("externalId", () => {
  it("is unique within a statement", () => {
    for (const f of [
      "v04-basic.xml",
      "batch.xml",
      "no-refs.xml",
      "qr-reference.xml",
      "reversal.xml",
    ]) {
      for (const st of parse(f)) {
        const ids = st.transactions.map((t) => t.externalId);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("hashes entries without references and separates identical bookings", () => {
    const [s] = parse("no-refs.xml");
    const ids = s!.transactions.map((t) => t.externalId);
    expect(ids[0]).toMatch(/^hash:[0-9a-f]{64}$/);
    expect(ids[1]).toBe(`${ids[0]}#2`);
    expect(ids[2]).toMatch(/^hash:[0-9a-f]{64}$/);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("is deterministic across parses", () => {
    expect(
      parse("no-refs.xml")[0]!.transactions.map((t) => t.externalId),
    ).toEqual(parse("no-refs.xml")[0]!.transactions.map((t) => t.externalId));
  });

  it("does not depend on statement id or position in the file", () => {
    const entry = ntry(
      "9.00",
      "DBIT",
      "<NtryDtls><TxDtls><RmtInf><Ustrd>x</Ustrd></RmtInf></TxDtls></NtryDtls>",
    );
    const a = parseCamt053(stmt(entry))[0]!.transactions[0]!.externalId;
    const b = parseCamt053(
      stmt(ntry("1.00", "CRDT") + entry).replace(
        "<Id>S</Id>",
        "<Id>OTHER</Id>",
      ),
    )[0]!.transactions[1]!.externalId;
    expect(b).toBe(a);
  });

  it("changes when the booking differs", () => {
    const a = parseCamt053(stmt(ntry("9.00", "DBIT")))[0]!.transactions[0]!
      .externalId;
    const b = parseCamt053(stmt(ntry("9.01", "DBIT")))[0]!.transactions[0]!
      .externalId;
    const c = parseCamt053(stmt(ntry("9.00", "CRDT")))[0]!.transactions[0]!
      .externalId;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("ignores NtryRef when there is no bank reference", () => {
    const withRef = (r: string) =>
      parseCamt053(stmt(ntry("9.00", "DBIT", `<NtryRef>${r}</NtryRef>`)))[0]!
        .transactions[0]!.externalId;
    expect(withRef("7")).toBe(withRef("42"));
    expect(withRef("7")).toMatch(/^hash:[0-9a-f]{64}$/);
  });

  it("gives shared bookings the same ids when NtryRef is a per-file sequence", () => {
    const [a] = parse("overlap-ntryref-a.xml");
    const [b] = parse("overlap-ntryref-b.xml");
    const idsA = a!.transactions.map((t) => t.externalId);
    const idsB = b!.transactions.map((t) => t.externalId);
    expect(a!.transactions).toHaveLength(5);
    expect(b!.transactions).toHaveLength(5);
    const shared = idsA.filter((id) => idsB.includes(id));
    expect(shared).toHaveLength(4);
    expect(new Set([...idsA, ...idsB]).size).toBe(6);
    expect(idsA.every((id) => !id.startsWith("ntry:"))).toBe(true);
    parse("overlap-ntryref-a.xml").forEach(expectReconciles);
    parse("overlap-ntryref-b.xml").forEach(expectReconciles);
  });

  it("keeps identical same-day bookings apart and stable across files", () => {
    const [a] = parse("overlap-ntryref-a.xml");
    const [b] = parse("overlap-ntryref-b.xml");
    const kiosk = (s: NormalizedStatement) =>
      s.transactions
        .filter((t) => t.counterpartyName === "Example Kiosk Ltd")
        .map((t) => t.externalId);
    expect(kiosk(a!)).toHaveLength(2);
    expect(new Set(kiosk(a!)).size).toBe(2);
    expect(kiosk(b!)).toEqual(kiosk(a!));
  });

  it("uses EndToEndId with date and amount before hashing", () => {
    const [a] = parse("overlap-ntryref-a.xml");
    const e2e = a!.transactions.find((t) => t.amount === 8000)!;
    expect(e2e.externalId).toMatch(
      /^e2e:E2E-EXAMPLE-0001:2024-07-05:8000:n-[0-9a-f]{16}$/,
    );
  });

  it("separates bookings that reuse an EndToEndId by counterparty", () => {
    const booking = (party: string, refs: string) =>
      parseCamt053(
        stmt(
          ntry(
            "9.00",
            "DBIT",
            `<NtryDtls><TxDtls><Refs>${refs}</Refs><RltdPties>${party}</RltdPties></TxDtls></NtryDtls>`,
          ),
        ),
      )[0]!.transactions[0]!.externalId;
    const byIban = (iban: string) =>
      `<Cdtr><Nm>Same Name</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban}</IBAN></Id></CdtrAcct>`;
    const byName = (name: string) => `<Cdtr><Nm>${name}</Nm></Cdtr>`;
    const e2e = "<EndToEndId>E1</EndToEndId>";
    const txid = "<TxId>T1</TxId>";

    // X and Y: same day, same amount, same EndToEndId, different payees.
    const x = booking(byIban(IBAN_DE), e2e);
    const y = booking(byIban(IBAN_GB), e2e);
    expect(x).toMatch(/^e2e:E1:2024-01-02:-900:/);
    expect(x).toContain(IBAN_DE);
    expect(x).not.toBe(y);
    // Without an IBAN the name separates them, ignoring case and spacing.
    expect(booking(byName("Alpha Ltd"), e2e)).not.toBe(
      booking(byName("Beta Ltd"), e2e),
    );
    expect(booking(byName("Alpha  Ltd"), e2e)).toBe(
      booking(byName("alpha ltd"), e2e),
    );
    expect(booking(byIban(IBAN_DE), txid)).toMatch(/^txid:T1:2024-01-02:-900:/);
    expect(booking(byIban(IBAN_DE), txid)).not.toBe(
      booking(byIban(IBAN_GB), txid),
    );
  });

  it("prefers TxDtls AcctSvcrRef, then UETR, then EndToEndId", () => {
    const tx = (refs: string) =>
      parseCamt053(
        stmt(
          ntry(
            "9.00",
            "DBIT",
            `<NtryRef>3</NtryRef><NtryDtls><TxDtls><Refs>${refs}</Refs></TxDtls></NtryDtls>`,
          ),
        ),
      )[0]!.transactions[0]!.externalId;
    const e2e = "<EndToEndId>E1</EndToEndId>";
    const uetr = "<UETR>123e4567-e89b-42d3-a456-426614174000</UETR>";
    expect(tx(`<AcctSvcrRef>TX-9</AcctSvcrRef>${uetr}${e2e}`)).toBe(
      "acsr:TX-9",
    );
    expect(tx(`${e2e}${uetr}`)).toBe(
      "uetr:123e4567-e89b-42d3-a456-426614174000",
    );
    expect(tx(e2e)).toBe("e2e:E1:2024-01-02:-900");
    expect(tx("<EndToEndId>NOTPROVIDED</EndToEndId>")).toMatch(/^hash:/);
  });

  it("separates reversals and negative amounts from the original booking", () => {
    const id = (ind: string, amt: string, rv: string) =>
      parseCamt053(stmt(ntry(amt, ind, `<RvslInd>${rv}</RvslInd>`)))[0]!
        .transactions[0]!.externalId;
    expect(id("DBIT", "9.00", "false")).not.toBe(id("CRDT", "9.00", "true"));
    expect(id("DBIT", "9.00", "false")).not.toBe(id("DBIT", "9.00", "true"));
    expect(id("DBIT", "0.00", "false")).toMatch(/^hash:/);
  });

  it("hashes the currency and counterparty name", () => {
    const base = (cur: string, name: string) =>
      parseCamt053(
        stmt(
          ntry(
            "9.00",
            "DBIT",
            `<NtryDtls><TxDtls><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>`,
            cur,
          ),
        ),
      )[0]!.transactions[0]!.externalId;
    expect(base("CHF", "A")).not.toBe(base("CHF", "B"));
    expect(base("CHF", "A")).not.toBe(base("EUR", "A"));
  });

  it("derives legacy ids matching what earlier versions stored", () => {
    const e = (r: string) =>
      parseCamt053(stmt(ntry("9.00", "DBIT", `<NtryRef>${r}</NtryRef>`)))[0]!
        .transactions[0]!;
    expect(e("7").legacyExternalIds).toEqual(["ntry:7:2024-01-02:-900"]);
    expect(
      parseCamt053(stmt(ntry("9.00", "DBIT")))[0]!.transactions[0]!
        .legacyExternalIds![0],
    ).toMatch(/^hash:/);
    expect(
      parseCamt053(
        stmt(ntry("9.00", "DBIT", "<AcctSvcrRef>A1</AcctSvcrRef>")),
      )[0]!.transactions[0]!.legacyExternalIds,
    ).toBeUndefined();
  });

  it("prefers AcctSvcrRef over NtryRef and disambiguates repeated references", () => {
    const e = ntry(
      "9.00",
      "DBIT",
      "<NtryRef>7</NtryRef><AcctSvcrRef>DUP</AcctSvcrRef>",
    );
    const [s] = parseCamt053(stmt(e + e));
    expect(s!.transactions.map((t) => t.externalId)).toEqual([
      "acsr:DUP",
      "acsr:DUP#2",
    ]);
  });

  it("has no duplicates in the union of overlapping files", () => {
    const [a] = parse("overlap-a.xml");
    const [b] = parse("overlap-b.xml");
    expect(a!.transactions).toHaveLength(5);
    expect(b!.transactions).toHaveLength(5);
    const byId = new Map<string, unknown>();
    for (const t of [...a!.transactions, ...b!.transactions]) {
      const prev = byId.get(t.externalId);
      if (prev) expect(prev).toEqual(t);
      byId.set(t.externalId, t);
    }
    expect(byId.size).toBe(7);
    const shared = a!.transactions
      .map((t) => t.externalId)
      .filter((id) => b!.transactions.some((t) => t.externalId === id));
    expect(shared).toHaveLength(3);
    expect(shared.some((id) => id.startsWith("hash:"))).toBe(true);
  });

  it("reconciles both overlapping statements", () => {
    parse("overlap-a.xml").forEach(expectReconciles);
    parse("overlap-b.xml").forEach(expectReconciles);
  });
});

describe("description", () => {
  const tx = (inner: string, entryExtra = "") =>
    parseCamt053(
      stmt(
        ntry(
          "1.00",
          "DBIT",
          `${entryExtra}<NtryDtls><TxDtls>${inner}</TxDtls></NtryDtls>`,
        ),
      ),
    )[0]!.transactions[0]!;

  it("joins Ustrd lines, then AddtlTxInf, then AddtlNtryInf", () => {
    expect(
      tx(
        "<RmtInf><Ustrd> one </Ustrd><Ustrd>two</Ustrd></RmtInf><AddtlTxInf>ignored</AddtlTxInf>",
      ).description,
    ).toBe("one two");
    expect(
      tx(
        "<AddtlTxInf> tx info </AddtlTxInf>",
        "<AddtlNtryInf>entry</AddtlNtryInf>",
      ).description,
    ).toBe("tx info");
    expect(tx("", "<AddtlNtryInf>entry</AddtlNtryInf>").description).toBe(
      "entry",
    );
  });

  it("is null when nothing is present or only whitespace", () => {
    expect(tx("").description).toBeNull();
    expect(tx("<RmtInf><Ustrd>   </Ustrd></RmtInf>").description).toBeNull();
  });
});

describe("malformed input", () => {
  const reject = (input: string, message: RegExp) => {
    expect(() => parseCamt053(input)).toThrow(ImportFormatError);
    expect(() => parseCamt053(input)).toThrow(message);
  };

  it("rejects empty input", () => {
    reject("", /Empty file/);
    reject("  \n ", /Empty file/);
  });

  it("rejects invalid XML", () => {
    reject("<Document><a></Document>", /Invalid XML/);
    reject("not xml at all", /Invalid XML/);
  });

  it("rejects other XML", () => {
    reject("<Foo><Bar/></Foo>", /Document/);
    reject(
      '<Document xmlns="urn:example:other"><X/></Document>',
      /unrecognized namespace/,
    );
    reject(
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08"><BkToCstmrDbtCdtNtfctn/></Document>',
      /camt\.054\.001\.08/,
    );
    reject(
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn/></Document>',
      /pain\.001\.001\.03/,
    );
    reject(
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"><Other/></Document>',
      /BkToCstmrStmt/,
    );
  });

  it("rejects DOCTYPE and entity declarations", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE Document [<!ENTITY x SYSTEM "file:///etc/passwd">]>${stmt("")}`;
    reject(xxe, /DOCTYPE/);
  });

  it("accepts a leading byte order mark", () => {
    const xml = String.fromCharCode(0xfeff) + load("v02-basic.xml");
    expect(parseCamt053(xml)[0]!.transactions).toHaveLength(1);
  });

  it("rejects oversized input", () => {
    reject(" ".repeat(26_000_000) + "<a/>", /too large/);
  });

  it("names the problem for bad dates", () => {
    reject(
      stmt(ntry("1.00", "CRDT").replace("2024-01-02", "2024-13-45")),
      /booking date/,
    );
  });

  it("names the problem for a missing amount or currency", () => {
    reject(stmt(ntry("1.00", "CRDT").replace(' Ccy="CHF"', "")), /currency/);
    reject(
      stmt(ntry("1.00", "CRDT").replace(/<Amt.*<\/Amt>/, "")),
      /no amount/,
    );
  });

  it("does not return a partial result when one statement is bad", () => {
    const bad = `${stmt(ntry("1.00", "CRDT")).replace("</BkToCstmrStmt></Document>", "")}<Stmt><Id>B</Id><Acct><Ccy>CHF</Ccy></Acct></Stmt></BkToCstmrStmt></Document>`;
    reject(bad, /Stmt #2/);
  });
});

describe("review fixes", () => {
  const details = (inner: string) =>
    `<NtryDtls><TxDtls>${inner}</TxDtls></NtryDtls>`;
  const one = (entry: string) => parseCamt053(stmt(entry))[0]!.transactions[0]!;

  it("decodes predefined entities and numeric references", () => {
    const tx = one(
      ntry(
        "1.00",
        "DBIT",
        details(
          "<RltdPties><Cdtr><Nm>Tom &amp; Jerry &lt;Ltd&gt; &quot;X&quot; &apos;Y&apos; caf&#233; &#xE9; &amp;lt;</Nm></Cdtr></RltdPties><RmtInf><Ustrd>A &amp; B &#x1F600; &#65;</Ustrd></RmtInf>",
        ),
      ),
    );
    expect(tx.counterpartyName).toBe(`Tom & Jerry <Ltd> "X" 'Y' café é &lt;`);
    expect(tx.description).toBe("A & B \u{1F600} A");
  });

  it("rejects invalid numeric character references", () => {
    for (const ref of ["&#0;", "&#xD800;", "&#x110000;", "&#8;"]) {
      expect(() =>
        parseCamt053(
          stmt(
            ntry("1.00", "DBIT", details(`<AddtlTxInf>a${ref}</AddtlTxInf>`)),
          ),
        ),
      ).toThrow(/character reference/);
    }
  });

  it("reports out-of-range amounts as a format error", () => {
    expect(() =>
      parseCamt053(stmt(ntry("99999999999999999999.00", "CRDT"))),
    ).toThrow(/out of range/);
    const part = (a: string) =>
      `<TxDtls><AmtDtls><TxAmt><Amt Ccy="CHF">${a}</Amt></TxAmt></AmtDtls></TxDtls>`;
    const big = "60000000000000.00";
    expect(() =>
      parseCamt053(
        stmt(
          ntry(big, "CRDT", `<NtryDtls>${part(big)}${part(big)}</NtryDtls>`),
        ),
      ),
    ).toThrow(/out of range/);
  });

  it("uses only the TxDtls for originalAmount in split batches", () => {
    const part = (a: string, extra = "") =>
      `<TxDtls><Amt Ccy="CHF">${a}</Amt>${extra}</TxDtls>`;
    const entry = ntry(
      "100.00",
      "DBIT",
      `<AmtDtls><InstdAmt><Amt Ccy="USD">120.00</Amt></InstdAmt></AmtDtls><NtryDtls>${part("60.00")}${part("40.00", '<AmtDtls><TxAmt><Amt Ccy="EUR">38.00</Amt></TxAmt></AmtDtls>')}</NtryDtls>`,
    );
    const txs = parseCamt053(stmt(entry))[0]!.transactions;
    expect(
      txs.map((t) => [t.amount, t.originalAmount, t.originalCurrency]),
    ).toEqual([
      [-6000, null, null],
      [-4000, -3800, "EUR"],
    ]);
  });

  it("prefers TxDtls/Amt over AmtDtls/TxAmt when splitting", () => {
    const part = (a: string) =>
      `<TxDtls><Amt Ccy="CHF">${a}</Amt><AmtDtls><TxAmt><Amt Ccy="EUR">1.00</Amt></TxAmt></AmtDtls></TxDtls>`;
    const txs = parseCamt053(
      stmt(
        ntry(
          "100.00",
          "CRDT",
          `<NtryDtls>${part("60.00")}${part("40.00")}</NtryDtls>`,
        ),
      ),
    )[0]!.transactions;
    expect(txs.map((t) => t.amount)).toEqual([6000, 4000]);
  });

  it("never returns the statement's own IBAN as counterparty", () => {
    const own = (role: string) =>
      `<${role}><Nm>Me</Nm></${role}><${role}Acct><Id><IBAN>${IBAN_CH}</IBAN></Id></${role}Acct>`;
    const both = one(
      ntry(
        "5.00",
        "CRDT",
        `<RvslInd>true</RvslInd>${details(`<RltdPties>${own("Cdtr")}<Dbtr><Nm>Somebody</Nm></Dbtr><DbtrAcct><Id><IBAN>${IBAN_DE}</IBAN></Id></DbtrAcct></RltdPties>`)}`,
      ),
    );
    expect(both).toMatchObject({
      counterpartyName: "Somebody",
      counterpartyIban: IBAN_DE,
    });
    const none = one(
      ntry(
        "5.00",
        "CRDT",
        `<RvslInd>1</RvslInd>${details(`<RltdPties>${own("Cdtr")}</RltdPties>`)}`,
      ),
    );
    expect(none).toMatchObject({
      counterpartyName: null,
      counterpartyIban: null,
    });
    const normal = one(
      ntry("5.00", "DBIT", details(`<RltdPties>${own("Cdtr")}</RltdPties>`)),
    );
    expect(normal.counterpartyIban).toBeNull();
  });

  it("accepts RvslInd true and 1 only", () => {
    const rev = (v: string) =>
      one(ntry("1.00", "CRDT", `<RvslInd>${v}</RvslInd>`)).reversal;
    expect(rev("1")).toBe(true);
    expect(rev("true")).toBe(true);
    expect(rev("false")).toBe(false);
    expect(rev("0")).toBe(false);
    expect(one(ntry("1.00", "CRDT", "<RvslInd>1</RvslInd>")).amount).toBe(100);
  });

  it("accepts URL namespaces with a suffix", () => {
    const xml = load("v04-basic.xml").replace(
      "urn:iso:std:iso:20022:tech:xsd:camt.053.001.04",
      "http://www.example-clearing.test/de/camt.053.001.04.ch.02.xsd",
    );
    expect(parseCamt053(xml)[0]!.transactions).toHaveLength(4);
    expect(() =>
      parseCamt053(
        xml.replace("camt.053.001.04.ch.02.xsd", "camt.054.001.04.ch.02.xsd"),
      ),
    ).toThrow(/camt\.054/);
  });

  it("treats NOTPROVIDED references as absent", () => {
    const tx = one(
      ntry(
        "1.00",
        "DBIT",
        "<AcctSvcrRef>NOTPROVIDED</AcctSvcrRef><NtryRef>NOTPROVIDED</NtryRef>",
      ),
    );
    expect(tx.externalId).toMatch(/^hash:/);
  });
});
