import { describe, expect, it } from "vitest";
import { parseCamt053 } from "../../src/lib/server/importers/camt053";
import { minor, parseAmount } from "../../src/lib/money";
import { ACCOUNTS } from "./dataset";
import { buildCamt053, quarterlyStatements } from "./camt";
import { WALLET_OPENING, buildLedger, type Entry } from "./ledger";

const opening = (key: string) =>
  parseAmount(ACCOUNTS.find((a) => a.key === key)!.openingBalance);

function statementsOf(today: string) {
  const ledger = buildLedger(today);
  const iban = (key: string) => ACCOUNTS.find((a) => a.key === key)!.iban!;
  return [
    ["checking", ledger.checking, opening("checking")],
    ["savings", ledger.savings, opening("savings")],
    ["wallet", ledger.wallet, WALLET_OPENING],
  ].flatMap(([key, entries, start]) =>
    quarterlyStatements(
      key as string,
      iban(key as string),
      "CHF",
      start as ReturnType<typeof minor>,
      entries as Entry[],
      today,
    ),
  );
}

describe("quarterlyStatements", () => {
  it("cuts the history into quarters that end today", () => {
    const checking = statementsOf("2026-11-24").filter((s) =>
      s.id.includes("checking"),
    );
    expect(checking.map((s) => [s.from, s.to])).toEqual([
      ["2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-06-30"],
      ["2026-07-01", "2026-09-30"],
      ["2026-10-01", "2026-11-24"],
    ]);
  });

  it("opens each quarter where the last one closed", () => {
    for (const today of ["2026-02-03", "2026-11-24", "2027-02-01"]) {
      const all = statementsOf(today);
      for (const key of ["checking", "savings", "wallet"]) {
        const list = all.filter((s) => s.id.includes(key));
        expect(list.length).toBeGreaterThan(0);
        list.forEach((s, i) => {
          const start = i === 0 ? null : list[i - 1]!.closing.amount;
          if (start !== null) expect(s.opening.amount).toBe(start);
          const sum = s.entries.reduce((total, e) => total + e.amount, 0);
          expect(s.opening.amount + sum).toBe(s.closing.amount);
        });
      }
    }
  });

  it("builds files the server's own importer reads back", () => {
    for (const statement of statementsOf("2026-11-24")) {
      const [parsed, ...rest] = parseCamt053(buildCamt053(statement));
      expect(rest).toEqual([]);
      expect(parsed!.accountIban).toBe(statement.iban);
      expect(parsed!.currency).toBe("CHF");
      expect(parsed!.fromDate).toBe(statement.from);
      expect(parsed!.toDate).toBe(statement.to);
      expect(parsed!.openingBalance).toEqual({
        amount: statement.opening.amount,
        currency: "CHF",
        date: statement.opening.date,
      });
      expect(parsed!.closingBalance).toEqual({
        amount: statement.closing.amount,
        currency: "CHF",
        date: statement.closing.date,
      });
      expect(parsed!.transactions).toHaveLength(statement.entries.length);
      const sum = parsed!.transactions.reduce((t, x) => t + x.amount, 0);
      expect(parsed!.openingBalance!.amount + sum).toBe(
        parsed!.closingBalance!.amount,
      );
    }
  });

  it("gives every booking an id that survives the next day's file", () => {
    const idsOf = (today: string) =>
      new Map(
        statementsOf(today).flatMap((s) =>
          parseCamt053(buildCamt053(s)).flatMap((p) =>
            p.transactions.map((t) => [`${s.iban}|${t.externalId}`, t]),
          ),
        ),
      );
    const earlier = idsOf("2026-10-20");
    const later = idsOf("2026-11-24");
    expect(earlier.size).toBeGreaterThan(100);
    for (const [key, tx] of earlier) {
      expect(later.get(key)).toEqual(tx);
      expect(key.split("|")[1]!.startsWith("acsr:DEMO-")).toBe(true);
    }
  });

  it("carries counterparty, description and reference", () => {
    const statements = statementsOf("2026-11-24");
    const parsed = statements
      .filter((s) => s.id.includes("checking"))
      .flatMap((s) => parseCamt053(buildCamt053(s))[0]!.transactions);
    const payment = parsed.find(
      (t) => t.reference !== null && t.referenceType === "SCOR",
    )!;
    expect(payment.counterpartyName).toMatch(/^Example /);
    expect(payment.description).toMatch(/^Invoice /);
    const pillar = parsed.find((t) => t.referenceType === "QRR")!;
    expect(pillar.amount).toBe(-725_800);
    expect(pillar.counterpartyIban).not.toBeNull();
  });

  it("escapes markup in names and texts", () => {
    const entry: Entry = {
      id: "DEMO-X-1",
      date: "2026-01-05",
      amount: minor(-1250),
      counterparty: 'Fish & Chips <"Example">',
      counterpartyIban: null,
      description: "5 > 3 & 2 < 4",
      reference: null,
    };
    const xml = buildCamt053({
      id: "DEMO-X",
      iban: ACCOUNTS[0]!.iban!,
      currency: "CHF",
      from: "2026-01-01",
      to: "2026-01-31",
      opening: { amount: minor(0), date: "2026-01-01" },
      closing: { amount: minor(-1250), date: "2026-01-31" },
      entries: [entry],
    });
    const [tx] = parseCamt053(xml)[0]!.transactions;
    expect(tx!.counterpartyName).toBe(entry.counterparty);
    expect(tx!.description).toBe(entry.description);
  });

  it("writes a negative balance as a debit", () => {
    const xml = buildCamt053({
      id: "DEMO-N",
      iban: ACCOUNTS[0]!.iban!,
      currency: "CHF",
      from: "2026-01-01",
      to: "2026-01-31",
      opening: { amount: minor(-86_040), date: "2026-01-01" },
      closing: { amount: minor(-86_040), date: "2026-01-31" },
      entries: [],
    });
    expect(parseCamt053(xml)[0]!.openingBalance!.amount).toBe(-86_040);
  });
});
