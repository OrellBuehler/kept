import { describe, expect, it } from "vitest";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  FOREIGN_IBANS,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  counterAmount,
  matchMirrors,
  pairIsConsistent,
  planLinks,
  shiftDate,
  type PlanAccount,
  type PlanTransaction,
} from "./plan";

const IBAN_A = EXAMPLE_IBAN;
const IBAN_B = EXAMPLE_IBAN_OTHER;
const IBAN_C = FOREIGN_IBANS[0]!;

const acc = (id: string, over: Partial<PlanAccount> = {}): PlanAccount => ({
  id,
  name: `Account ${id}`,
  currency: "CHF",
  type: "current",
  iban: null,
  openingDate: null,
  fillFromTransfers: false,
  hasPortfolios: false,
  archived: false,
  ...over,
});

const A = acc("a", { iban: IBAN_A });
const B = acc("b", { iban: IBAN_B, fillFromTransfers: true });

let n = 0;
const tx = (over: Partial<PlanTransaction>): PlanTransaction => ({
  id: `t${++n}`,
  accountId: "a",
  source: "import",
  bookingDate: "2024-03-10",
  valueDate: null,
  amount: -10000,
  currency: "CHF",
  originalAmount: null,
  originalCurrency: null,
  counterpartyIban: over.accountId === "b" ? IBAN_A : IBAN_B,
  description: "Move",
  reference: null,
  referenceType: null,
  ...over,
});

const plan = (
  sources: PlanTransaction[],
  candidates: PlanTransaction[] = [],
  accounts: PlanAccount[] = [A, B],
  taken: string[] = [],
  pending: string[] = [],
) =>
  planLinks({
    sources,
    candidates,
    accounts,
    taken: new Set(taken),
    pending: new Set(pending),
  });

describe("planLinks", () => {
  it("mirrors an outgoing payment onto a filled account with flipped sign", () => {
    const out = tx({ valueDate: "2024-03-11", reference: "R1" });
    const [link] = plan([out]);
    expect(link).toMatchObject({
      kind: "mirror",
      sourceId: out.id,
      outTransactionId: out.id,
      inTransactionId: null,
      fromAccountId: "a",
      toAccountId: "b",
      mirror: {
        accountId: "b",
        bookingDate: "2024-03-10",
        valueDate: "2024-03-11",
        amount: 10000,
        currency: "CHF",
        counterpartyName: "Account a",
        counterpartyIban: IBAN_A,
        description: "Move",
        reference: "R1",
      },
    });
  });

  it("mirrors an incoming payment as a debit on the other account", () => {
    const into = tx({ amount: 2500 });
    const [link] = plan([into]);
    expect(link).toMatchObject({
      kind: "mirror",
      inTransactionId: into.id,
      outTransactionId: null,
      fromAccountId: "b",
      toAccountId: "a",
      mirror: { amount: -2500 },
    });
  });

  it("matches IBANs regardless of spaces and case", () => {
    const out = tx({
      counterpartyIban: IBAN_B.toLowerCase().replace(/(.{4})/g, "$1 "),
    });
    expect(plan([out])).toHaveLength(1);
  });

  it("pairs with the opposite row of the same amount within five days", () => {
    const out = tx({});
    const other = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-14",
      counterpartyIban: IBAN_A,
    });
    const [link] = plan([out], [other]);
    expect(link).toMatchObject({
      kind: "pair",
      sourceId: out.id,
      candidateId: other.id,
      outTransactionId: out.id,
      inTransactionId: other.id,
    });
  });

  it("pairs even when the counterpart is not filled from transfers", () => {
    const out = tx({});
    const other = tx({ accountId: "b", amount: 10000 });
    const off = acc("b", { iban: IBAN_B });
    expect(plan([out], [other], [A, off])).toHaveLength(1);
  });

  it("does not pair across more than five days and mirrors instead", () => {
    const out = tx({});
    const late = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-16",
    });
    expect(plan([out], [late])).toMatchObject([{ kind: "mirror" }]);
  });

  it("does not pair rows of equal sign or another amount", () => {
    const out = tx({});
    const same = tx({ accountId: "b", amount: -10000 });
    const other = tx({ accountId: "b", amount: 9999 });
    expect(plan([out], [same, other])).toMatchObject([{ kind: "mirror" }]);
  });

  it("does not pair with a row that names a different counterparty", () => {
    const out = tx({});
    const stranger = tx({
      accountId: "b",
      amount: 10000,
      counterpartyIban: IBAN_C,
    });
    expect(plan([out], [stranger])).toMatchObject([{ kind: "mirror" }]);
  });

  it("picks the unique closest candidate", () => {
    const out = tx({});
    const near = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-11",
    });
    const far = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-14",
    });
    const [link] = plan([out], [far, near]);
    expect(link).toMatchObject({ kind: "pair", candidateId: near.id });
  });

  it("skips an ambiguous pair entirely, without a mirror", () => {
    const out = tx({});
    const before = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-09",
    });
    const after = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-11",
    });
    expect(plan([out], [before, after])).toEqual([]);
  });

  it("never uses a candidate twice", () => {
    const first = tx({ bookingDate: "2024-03-10" });
    const second = tx({ bookingDate: "2024-03-12" });
    const only = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-11",
    });
    const result = plan([second, first], [only]);
    expect(result.filter((r) => r.kind === "pair")).toHaveLength(1);
    expect(result.find((r) => r.kind === "pair")).toMatchObject({
      sourceId: first.id,
    });
  });

  it("links two real rows once when both name each other", () => {
    const out = tx({});
    const into = tx({
      accountId: "b",
      amount: 10000,
      counterpartyIban: IBAN_A,
    });
    const result = plan([out, into], [out, into]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "pair" });
  });

  it("creates no mirror when the toggle is off", () => {
    const off = acc("b", { iban: IBAN_B });
    expect(plan([tx({})], [], [A, off])).toEqual([]);
  });

  it("creates no mirror on a pillar 3a account or one with portfolios", () => {
    const p3a = acc("b", {
      iban: IBAN_B,
      type: "pillar_3a",
      fillFromTransfers: true,
    });
    const withPortfolio = acc("b", {
      iban: IBAN_B,
      fillFromTransfers: true,
      hasPortfolios: true,
    });
    expect(plan([tx({})], [], [A, p3a])).toEqual([]);
    expect(plan([tx({})], [], [A, withPortfolio])).toEqual([]);
  });

  it("creates no mirror before the opening date", () => {
    const opened = acc("b", {
      iban: IBAN_B,
      fillFromTransfers: true,
      openingDate: "2024-03-11",
    });
    expect(plan([tx({ bookingDate: "2024-03-10" })], [], [A, opened])).toEqual(
      [],
    );
    expect(
      plan([tx({ bookingDate: "2024-03-11" })], [], [A, opened]),
    ).toHaveLength(1);
  });

  it("ignores counterparties that are not the user's accounts and the account itself", () => {
    expect(plan([tx({ counterpartyIban: IBAN_C })])).toEqual([]);
    expect(plan([tx({ counterpartyIban: IBAN_A })])).toEqual([]);
    expect(plan([tx({ counterpartyIban: null })])).toEqual([]);
    expect(plan([tx({ amount: 0 })])).toEqual([]);
  });

  it("never mirrors onto an archived account, but still pairs with it", () => {
    const archived = acc("b", {
      iban: IBAN_B,
      fillFromTransfers: true,
      archived: true,
    });
    expect(plan([tx({})], [], [A, archived])).toEqual([]);
    const real = tx({ accountId: "b", amount: 10000 });
    expect(plan([tx({})], [real], [A, archived])).toMatchObject([
      { kind: "pair" },
    ]);
  });

  it("gives a candidate to the closest source, not to the first one", () => {
    const early = tx({ bookingDate: "2024-03-08" });
    const near = tx({ bookingDate: "2024-03-12" });
    const only = tx({
      accountId: "b",
      amount: 10000,
      bookingDate: "2024-03-13",
    });
    const result = plan([early, near], [only]);
    expect(result.find((r) => r.kind === "pair")).toMatchObject({
      sourceId: near.id,
      candidateId: only.id,
    });
    expect(result.find((r) => r.kind === "mirror")).toMatchObject({
      sourceId: early.id,
    });
  });

  it("finds the same pairs among many candidates", () => {
    const sources = Array.from({ length: 50 }, (_, i) =>
      tx({ amount: -(1000 + i), bookingDate: "2024-03-10" }),
    );
    const candidates = Array.from({ length: 50 }, (_, i) =>
      tx({
        accountId: "b",
        amount: 1000 + i,
        bookingDate: "2024-03-11",
        counterpartyIban: IBAN_A,
      }),
    );
    const result = plan(sources, candidates);
    expect(result.every((r) => r.kind === "pair")).toBe(true);
    expect(result).toHaveLength(50);
    for (const link of result) {
      if (link.kind !== "pair") continue;
      const s = sources.find((x) => x.id === link.sourceId)!;
      const c = candidates.find((x) => x.id === link.candidateId)!;
      expect(c.amount).toBe(-s.amount);
    }
  });

  it("skips mirrors as sources and rows that already have a transfer", () => {
    const mirror = tx({ source: "mirror", counterpartyIban: IBAN_B });
    const dismissed = tx({});
    expect(plan([mirror, dismissed], [], [A, B], [dismissed.id])).toEqual([]);
  });

  it("does not pair with a row that has a transfer, dismissed included", () => {
    const out = tx({});
    const other = tx({ accountId: "b", amount: 10000 });
    expect(plan([out], [other], [A, B], [other.id])).toMatchObject([
      { kind: "mirror" },
    ]);
  });

  describe("foreign currency", () => {
    const eur = acc("b", {
      iban: IBAN_B,
      currency: "EUR",
      fillFromTransfers: true,
    });

    it("mirrors with the statement's counter-amount", () => {
      const out = tx({
        amount: -10000,
        originalAmount: -9300,
        originalCurrency: "EUR",
      });
      expect(plan([out], [], [A, eur])).toMatchObject([
        { kind: "mirror", mirror: { amount: 9300, currency: "EUR" } },
      ]);
    });

    it("asks for the amount when there is no counter-amount", () => {
      const out = tx({});
      expect(plan([out], [], [A, eur])).toMatchObject([
        {
          kind: "needs_amount",
          sourceId: out.id,
          outTransactionId: out.id,
          inTransactionId: null,
          fromAccountId: "a",
          toAccountId: "b",
        },
      ]);
    });

    it("asks for the amount when the original currency is a third one", () => {
      const out = tx({ originalAmount: -500, originalCurrency: "USD" });
      expect(plan([out], [], [A, eur])).toMatchObject([
        { kind: "needs_amount" },
      ]);
    });

    it("pairs through the original amount", () => {
      const out = tx({
        amount: -10000,
        originalAmount: -9300,
        originalCurrency: "EUR",
      });
      const real = tx({
        accountId: "b",
        amount: 9300,
        currency: "EUR",
        counterpartyIban: IBAN_A,
      });
      expect(plan([out], [real], [A, eur])).toMatchObject([
        { kind: "pair", candidateId: real.id },
      ]);
    });

    it("pairs a debit without a counter-amount with a later credit that carries the original amount", () => {
      const out = tx({});
      const real = tx({
        accountId: "b",
        amount: 9300,
        currency: "EUR",
        originalAmount: 10000,
        originalCurrency: "CHF",
        counterpartyIban: IBAN_A,
        bookingDate: "2024-03-11",
      });
      expect(plan([out], [real], [A, eur])).toMatchObject([
        {
          kind: "pair",
          sourceId: out.id,
          candidateId: real.id,
          outTransactionId: out.id,
          inTransactionId: real.id,
        },
      ]);
    });

    it("pairs the same two rows within one run, the debit dated earlier", () => {
      const out = tx({ bookingDate: "2024-03-09" });
      const real = tx({
        accountId: "b",
        amount: 9300,
        currency: "EUR",
        originalAmount: 10000,
        originalCurrency: "CHF",
        counterpartyIban: IBAN_A,
        bookingDate: "2024-03-11",
      });
      const result = plan([out, real], [out, real], [A, eur]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ kind: "pair" });
    });

    it("does not pair on an original amount of another size or currency", () => {
      const out = tx({});
      const wrongAmount = tx({
        accountId: "b",
        amount: 9300,
        currency: "EUR",
        originalAmount: 9000,
        originalCurrency: "CHF",
      });
      const wrongCurrency = tx({
        accountId: "b",
        amount: 9300,
        currency: "EUR",
        originalAmount: 10000,
        originalCurrency: "USD",
      });
      expect(plan([out], [wrongAmount, wrongCurrency], [A, eur])).toMatchObject(
        [{ kind: "needs_amount" }],
      );
    });

    it("pairs a waiting row instead of asking again, and leaves it waiting otherwise", () => {
      const out = tx({});
      expect(plan([out], [], [A, eur], [], [out.id])).toEqual([]);
      const real = tx({
        accountId: "b",
        amount: 9300,
        currency: "EUR",
        originalAmount: 10000,
        originalCurrency: "CHF",
        counterpartyIban: IBAN_A,
      });
      expect(
        plan([out, real], [out, real], [A, eur], [], [out.id]),
      ).toMatchObject([{ kind: "pair", candidateId: real.id }]);
      expect(plan([real], [out], [A, eur], [], [out.id])).toMatchObject([
        { kind: "pair", sourceId: real.id, candidateId: out.id },
      ]);
    });

    it("does not pair equal numbers in different currencies", () => {
      const out = tx({});
      const real = tx({ accountId: "b", amount: 10000, currency: "EUR" });
      expect(plan([out], [real], [A, eur])).toMatchObject([
        { kind: "needs_amount" },
      ]);
    });
  });
});

describe("counterAmount", () => {
  const src = {
    amount: -500,
    currency: "CHF",
    originalAmount: null,
    originalCurrency: null,
  };
  it("flips the sign within one currency", () => {
    expect(counterAmount(src, { currency: "CHF" })).toBe(500);
    expect(counterAmount({ ...src, amount: 500 }, { currency: "CHF" })).toBe(
      -500,
    );
  });
  it("is null for another currency without an original amount", () => {
    expect(counterAmount(src, { currency: "EUR" })).toBeNull();
  });
});

describe("shiftDate", () => {
  it("moves across month and year borders", () => {
    expect(shiftDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDate("2023-12-30", 5)).toBe("2024-01-04");
  });
});

describe("matchMirrors", () => {
  const mirror = (id: string, over = {}) => ({
    id,
    bookingDate: "2024-03-10",
    amount: 10000,
    counterpartyIban: IBAN_A,
    reference: "RF-7788",
    description: "Move to savings",
    ...over,
  });
  const row = (key: string, over = {}) => ({
    key,
    bookingDate: "2024-03-12",
    amount: 10000,
    counterpartyIban: IBAN_A,
    reference: null as string | null,
    description: null as string | null,
    ...over,
  });
  const blind = (key: string, over = {}) =>
    row(key, { counterpartyIban: null, reference: "RF-7788", ...over });

  it("matches by amount, date and counterparty", () => {
    expect(matchMirrors([row("r1")], [mirror("m1")])).toEqual(
      new Map([["r1", "m1"]]),
    );
  });

  it("does not match another amount, a date beyond five days or another counterparty", () => {
    expect(matchMirrors([row("r", { amount: 9999 })], [mirror("m")]).size).toBe(
      0,
    );
    expect(
      matchMirrors([row("r", { bookingDate: "2024-03-16" })], [mirror("m")])
        .size,
    ).toBe(0);
    expect(
      matchMirrors([row("r", { counterpartyIban: IBAN_C })], [mirror("m")])
        .size,
    ).toBe(0);
  });

  it("accepts a row without a counterparty only as the single match", () => {
    expect(matchMirrors([blind("r")], [mirror("m")])).toEqual(
      new Map([["r", "m"]]),
    );
    expect(matchMirrors([blind("r")], [mirror("m1"), mirror("m2")]).size).toBe(
      0,
    );
    expect(matchMirrors([blind("r1"), blind("r2")], [mirror("m")]).size).toBe(
      0,
    );
  });

  it("needs the same reference or a shared description word for a row without a counterparty", () => {
    expect(
      matchMirrors(
        [blind("r", { reference: null })],
        [mirror("m", { description: null })],
      ).size,
    ).toBe(0);
    expect(
      matchMirrors([blind("r", { reference: "OTHER" })], [mirror("m")]).size,
    ).toBe(0);
    expect(
      matchMirrors(
        [blind("r", { reference: null, description: "Savings top-up" })],
        [mirror("m")],
      ),
    ).toEqual(new Map([["r", "m"]]));
  });

  it("ignores short words, numbers and generic words as a signal", () => {
    const signal = (description: string) =>
      matchMirrors(
        [blind("r", { reference: null, description })],
        [mirror("m", { description: "Transfer 2024 to the savings" })],
      ).size;
    expect(signal("Transfer 2024 to a x")).toBe(0);
    expect(signal("transfer")).toBe(0);
    expect(signal("my savings")).toBe(1);
  });

  it("treats a row that names an IBAN as exact only when the mirror names the same one", () => {
    const noSignal = { reference: null, description: null };
    expect(
      matchMirrors(
        [row("r", noSignal)],
        [mirror("m", { counterpartyIban: null })],
      ).size,
    ).toBe(0);
    expect(
      matchMirrors(
        [row("r", { ...noSignal, reference: "RF-7788" })],
        [mirror("m", { counterpartyIban: null })],
      ),
    ).toEqual(new Map([["r", "m"]]));
    expect(
      matchMirrors([row("r", noSignal)], [mirror("m", { description: null })]),
    ).toEqual(new Map([["r", "m"]]));
  });

  it("never lets a row without a counterparty compete with an exact match", () => {
    const result = matchMirrors(
      [
        blind("blind", { bookingDate: "2024-03-10" }),
        row("exact", { bookingDate: "2024-03-12" }),
      ],
      [mirror("m")],
    );
    expect(result).toEqual(new Map([["exact", "m"]]));
  });

  it("uses each mirror once and prefers the closest date", () => {
    const result = matchMirrors(
      [
        row("far", { bookingDate: "2024-03-14" }),
        row("near", { bookingDate: "2024-03-10" }),
      ],
      [mirror("m")],
    );
    expect(result).toEqual(new Map([["near", "m"]]));
  });
});

describe("pairIsConsistent across currencies", () => {
  const eur = acc("e", { iban: IBAN_B, currency: "EUR" });
  const debit = tx({ amount: -10000, counterpartyIban: IBAN_B });
  const credit = (over: Partial<PlanTransaction> = {}) =>
    tx({
      accountId: "e",
      currency: "EUR",
      amount: 9300,
      bookingDate: "2024-03-11",
      counterpartyIban: IBAN_A,
      ...over,
    });

  it("accepts rows without an original amount when sign, window and IBANs fit", () => {
    expect(pairIsConsistent(debit, A, credit(), eur)).toBe(true);
  });

  it("still rejects a wrong sign, a distant date or another counterparty", () => {
    expect(pairIsConsistent(debit, A, credit({ amount: -9300 }), eur)).toBe(
      false,
    );
    expect(
      pairIsConsistent(debit, A, credit({ bookingDate: "2024-03-20" }), eur),
    ).toBe(false);
    expect(
      pairIsConsistent(debit, A, credit({ counterpartyIban: IBAN_C }), eur),
    ).toBe(false);
  });

  it("rejects a known original amount that disagrees", () => {
    expect(
      pairIsConsistent(
        { ...debit, originalAmount: -9000, originalCurrency: "EUR" },
        A,
        credit(),
        eur,
      ),
    ).toBe(false);
  });
});
