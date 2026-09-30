import { describe, expect, it } from "vitest";
import { minor, type Minor } from "$lib/money";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
  EXAMPLE_SCOR,
} from "$lib/testing/fixtures/bill-identifiers";
import {
  autoConfirmable,
  billDirectionAmount,
  computeBillStatus,
  isOverdue,
  suggestMatches,
  unallocatedAmount,
  validateAllocation,
  type Allocation,
  type MatchBill,
  type MatchTransaction,
  type Suggestion,
} from "./matching";

const IBAN = EXAMPLE_IBAN;
const OTHER_IBAN = EXAMPLE_IBAN_OTHER;
const QRR = EXAMPLE_QRR;
const SCOR = EXAMPLE_SCOR;
const spaced = (v: string) => v.replace(/(.{4})/g, "$1 ").trim();

function bill(over: Partial<MatchBill> = {}): MatchBill {
  return {
    id: "b1",
    kind: "invoice",
    currency: "CHF",
    amount: minor(10000),
    issueDate: "2026-03-01",
    dueDate: "2026-03-31",
    reference: null,
    referenceType: null,
    creditorIban: IBAN,
    creditorName: "Example Utilities AG",
    cancelled: false,
    ...over,
  };
}

function tx(over: Partial<MatchTransaction> = {}): MatchTransaction {
  return {
    id: "t1",
    bookingDate: "2026-03-20",
    amount: minor(-10000),
    currency: "CHF",
    reference: null,
    counterpartyIban: IBAN,
    counterpartyName: "Example Utilities AG",
    ...over,
  };
}

function alloc(
  billId: string,
  transactionId: string,
  amount: number,
): Allocation {
  return { billId, transactionId, amount: minor(amount) };
}

function only(list: Suggestion[]): Suggestion {
  expect(list).toHaveLength(1);
  return list[0];
}

describe("billDirectionAmount", () => {
  it.each([
    ["invoice", -10000, 10000],
    ["invoice", 2500, -2500],
    ["credit_note", 2500, 2500],
    ["credit_note", -2500, -2500],
    ["invoice", 0, 0],
  ] as const)("%s with tx %i gives %i", (kind, amount, expected) => {
    expect(
      billDirectionAmount(bill({ kind }), tx({ amount: minor(amount) })),
    ).toBe(expected);
  });
});

describe("computeBillStatus", () => {
  const cases: [string, Partial<MatchBill>, number[], string, number | null][] =
    [
      ["invoice no allocations", {}, [], "open", 10000],
      ["invoice partial", {}, [4000], "partially_paid", 6000],
      ["invoice exact", {}, [4000, 6000], "paid", 0],
      ["invoice over", {}, [12000], "overpaid", 0],
      [
        "invoice over then partly refunded",
        {},
        [12000, -2500],
        "partially_paid",
        500,
      ],
      ["invoice only refund allocated", {}, [-500], "open", 10500],
      ["open-amount unpaid", { amount: null }, [], "open", null],
      ["open-amount paid", { amount: null }, [777], "paid", null],
      [
        "credit note unsettled",
        { kind: "credit_note" },
        [],
        "credit_due",
        10000,
      ],
      [
        "credit note partly",
        { kind: "credit_note" },
        [3000],
        "credit_due",
        7000,
      ],
      ["credit note settled", { kind: "credit_note" }, [10000], "paid", 0],
      ["credit note over", { kind: "credit_note" }, [10100], "overpaid", 0],
      [
        "open-amount credit note unsettled",
        { kind: "credit_note", amount: null },
        [],
        "credit_due",
        null,
      ],
      [
        "open-amount credit note settled",
        { kind: "credit_note", amount: null },
        [5],
        "paid",
        null,
      ],
      [
        "cancelled ignores allocations",
        { cancelled: true },
        [10000],
        "cancelled",
        0,
      ],
    ];

  it.each(cases)("%s", (_name, over, amounts, status, remaining) => {
    const b = bill(over);
    const allocations = amounts.map((a, i) => alloc("b1", `t${i}`, a));
    const result = computeBillStatus(b, allocations, "2026-06-01");
    expect(result.status).toBe(status);
    expect(result.remaining).toBe(remaining);
    expect(result.settled).toBe(amounts.reduce((s, a) => s + a, 0));
  });

  it("ignores allocations of other bills", () => {
    const result = computeBillStatus(
      bill(),
      [alloc("other", "t1", 10000)],
      "2026-06-01",
    );
    expect(result).toEqual({ status: "open", settled: 0, remaining: 10000 });
  });

  it("refund of an overpayment brings the bill back to paid", () => {
    const result = computeBillStatus(
      bill(),
      [alloc("b1", "t1", 12000), alloc("b1", "t2", -2000)],
      "2026-06-01",
    );
    expect(result.status).toBe("paid");
  });
});

describe("isOverdue", () => {
  it.each([
    ["2026-03-30", "open", true],
    ["2026-03-31", "open", false],
    ["2026-04-01", "open", false],
    ["2026-03-30", "partially_paid", true],
    ["2026-03-30", "paid", false],
    ["2026-03-30", "overpaid", false],
    ["2026-03-30", "cancelled", false],
    ["2026-03-30", "credit_due", false],
    [null, "open", false],
  ] as const)("due %s / %s -> %s", (dueDate, status, expected) => {
    expect(isOverdue({ dueDate }, status, "2026-03-31")).toBe(expected);
  });
});

describe("unallocatedAmount", () => {
  it("returns the full signed amount without allocations", () => {
    expect(unallocatedAmount(tx(), [])).toBe(-10000);
    expect(unallocatedAmount(tx({ amount: minor(500) }), [])).toBe(500);
  });

  it("subtracts allocations of this transaction only", () => {
    const allocations = [
      alloc("b1", "t1", 6000),
      alloc("b2", "t1", 1000),
      alloc("b1", "other", 9999),
    ];
    expect(unallocatedAmount(tx(), allocations)).toBe(-3000);
  });

  it("mixed-sign allocations on one transaction all consume its absolute amount", () => {
    // outgoing payment: +6000 on an invoice, -1000 on a credit note
    const allocations = [alloc("inv", "t1", 6000), alloc("cn", "t1", -1000)];
    expect(unallocatedAmount(tx(), allocations)).toBe(-3000);
    // incoming refund: -2000 on an invoice, +500 on a credit note
    const incoming = [alloc("inv", "t2", -2000), alloc("cn", "t2", 500)];
    expect(
      unallocatedAmount(tx({ id: "t2", amount: minor(4000) }), incoming),
    ).toBe(1500);
  });

  it("counts negative allocations as consumption", () => {
    expect(
      unallocatedAmount(tx({ amount: minor(2000) }), [
        alloc("b1", "t1", -2000),
      ]),
    ).toBe(0);
  });

  it("never goes beyond zero", () => {
    expect(unallocatedAmount(tx(), [alloc("b1", "t1", 20000)])).toBe(0);
  });
});

describe("validateAllocation", () => {
  it("accepts a full payment", () => {
    expect(validateAllocation(bill(), tx(), minor(10000), [])).toBeNull();
  });

  it("accepts more than the bill's remaining amount (overpayment)", () => {
    expect(
      validateAllocation(bill({ amount: minor(5000) }), tx(), minor(10000), []),
    ).toBeNull();
  });

  it("accepts a refund as negative allocation on an invoice", () => {
    expect(
      validateAllocation(bill(), tx({ amount: minor(2000) }), minor(-2000), [
        alloc("b1", "p", 12000),
      ]),
    ).toBeNull();
  });

  it("accepts incoming payment on a credit note", () => {
    expect(
      validateAllocation(
        bill({ kind: "credit_note" }),
        tx({ amount: minor(10000) }),
        minor(10000),
        [],
      ),
    ).toBeNull();
  });

  it("rejects currency mismatch", () => {
    expect(
      validateAllocation(bill(), tx({ currency: "EUR" }), minor(10000), []),
    ).toMatch(/currency/i);
  });

  it("rejects zero", () => {
    expect(validateAllocation(bill(), tx(), minor(0), [])).toMatch(/zero/i);
  });

  it("rejects wrong direction", () => {
    expect(
      validateAllocation(
        bill(),
        tx({ amount: minor(10000) }),
        minor(10000),
        [],
      ),
    ).toMatch(/refund must be negative/);
    expect(validateAllocation(bill(), tx(), minor(-100), [])).not.toBeNull();
    expect(
      validateAllocation(bill({ kind: "credit_note" }), tx(), minor(100), []),
    ).toMatch(/reversal/);
  });

  it("rejects allocations on a zero-amount transaction", () => {
    expect(
      validateAllocation(bill(), tx({ amount: minor(0) }), minor(100), []),
    ).not.toBeNull();
  });

  it("rejects exceeding the transaction", () => {
    expect(validateAllocation(bill(), tx(), minor(10001), [])).toMatch(
      /exceeds/,
    );
  });

  it("respects existing allocations of the transaction", () => {
    const existing = [alloc("b2", "t1", 7000)];
    expect(validateAllocation(bill(), tx(), minor(3000), existing)).toBeNull();
    expect(validateAllocation(bill(), tx(), minor(3001), existing)).toMatch(
      /exceeds/,
    );
  });

  it("rejects refunds that would make the settled amount negative", () => {
    const refund = tx({ amount: minor(2000) });
    expect(validateAllocation(bill(), refund, minor(-2000), [])).toMatch(
      /refund exceeds/i,
    );
    const paid = [alloc("b1", "p", 1500)];
    expect(validateAllocation(bill(), refund, minor(-1501), paid)).toMatch(
      /refund exceeds/i,
    );
    expect(validateAllocation(bill(), refund, minor(-1500), paid)).toBeNull();
    const cn = bill({ kind: "credit_note" });
    const reversal = tx({ amount: minor(-2000) });
    expect(validateAllocation(cn, reversal, minor(-2000), [])).toMatch(
      /refund exceeds/i,
    );
    expect(
      validateAllocation(cn, reversal, minor(-2000), [alloc("b1", "p", 2000)]),
    ).toBeNull();
  });

  it("over-allocation check accounts for refund allocations already on the transaction", () => {
    const refund = tx({ id: "r", amount: minor(2000) });
    const existing = [alloc("b1", "p", 12000), alloc("b1", "r", -1500)];
    expect(
      validateAllocation(bill(), refund, minor(-500), existing),
    ).toBeNull();
    expect(validateAllocation(bill(), refund, minor(-501), existing)).toMatch(
      /exceeds the unallocated/,
    );
  });

  it("rejects cancelled bills", () => {
    expect(
      validateAllocation(bill({ cancelled: true }), tx(), minor(100), []),
    ).toMatch(/cancelled/);
  });

  it("supports splitting one payment over two bills", () => {
    const b1 = bill({ id: "b1", amount: minor(6000) });
    const b2 = bill({ id: "b2", amount: minor(4000) });
    const payment = tx();
    expect(validateAllocation(b1, payment, minor(6000), [])).toBeNull();
    const a1 = [alloc("b1", "t1", 6000)];
    expect(unallocatedAmount(payment, a1)).toBe(-4000);
    expect(validateAllocation(b2, payment, minor(4000), a1)).toBeNull();
    const a2 = [...a1, alloc("b2", "t1", 4000)];
    expect(unallocatedAmount(payment, a2)).toBe(0);
    expect(validateAllocation(b2, payment, minor(1), a2)).toMatch(/exceeds/);
  });
});

describe("suggestMatches: rule 1 (structured reference)", () => {
  it("matches a QRR reference exactly", () => {
    const s = only(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR", creditorIban: null })],
        [tx({ reference: QRR, counterpartyIban: null })],
        [],
      ),
    );
    expect(s).toEqual({
      billId: "b1",
      transactionId: "t1",
      rule: "reference",
      confidence: "exact",
      amount: 10000,
      ambiguous: false,
    });
    expect(autoConfirmable(s)).toBe(true);
  });

  it("matches SCOR and ignores spaces and case", () => {
    const s = only(
      suggestMatches(
        [bill({ reference: SCOR, referenceType: "SCOR" })],
        [tx({ reference: spaced(SCOR).toLowerCase() })],
        [],
      ),
    );
    expect(s.rule).toBe("reference");
  });

  it("matches a QRR stored in print format against a compact one", () => {
    const s = only(
      suggestMatches(
        [
          bill({
            reference: "21 00000 00003 13947 14300 09017",
            referenceType: "QRR",
          }),
        ],
        [tx({ reference: QRR })],
        [],
      ),
    );
    expect(s.rule).toBe("reference");
  });

  it("never matches NON or free-text references", () => {
    const result = suggestMatches(
      [
        bill({
          reference: "Invoice 2026-17",
          referenceType: "NON",
          creditorIban: null,
        }),
        bill({
          id: "b2",
          reference: "Invoice 2026-18",
          referenceType: null,
          creditorIban: null,
        }),
      ],
      [
        tx({ reference: "Invoice 2026-17" }),
        tx({ id: "t2", reference: "Invoice 2026-18" }),
      ],
      [],
    );
    expect(result).toEqual([]);
  });

  it("does not match when the currency differs", () => {
    expect(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR" })],
        [tx({ reference: QRR, currency: "EUR" })],
        [],
      ),
    ).toEqual([]);
  });

  it("does not match the wrong direction", () => {
    expect(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR", creditorIban: null })],
        [tx({ reference: QRR, amount: minor(10000) })],
        [],
      ),
    ).toEqual([]);
  });

  it("does not match a different reference", () => {
    expect(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR", creditorIban: null })],
        [tx({ reference: SCOR })],
        [],
      ),
    ).toEqual([]);
  });

  it("partial payment with the right reference is still exact", () => {
    const s = only(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR" })],
        [tx({ reference: QRR, amount: minor(-4000) })],
        [],
      ),
    );
    expect(s.amount).toBe(4000);
    expect(s.confidence).toBe("exact");
  });

  it("caps the amount at the remaining amount on overpayment", () => {
    const s = only(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR" })],
        [tx({ reference: QRR, amount: minor(-12000) })],
        [],
      ),
    );
    expect(s.amount).toBe(10000);
  });

  it("open-amount bill takes the whole payment by reference", () => {
    const s = only(
      suggestMatches(
        [bill({ amount: null, reference: QRR, referenceType: "QRR" })],
        [tx({ reference: QRR, amount: minor(-4321) })],
        [],
      ),
    );
    expect(s.amount).toBe(4321);
  });

  it("open-amount bill is never matched by IBAN and amount", () => {
    expect(suggestMatches([bill({ amount: null })], [tx()], [])).toEqual([]);
  });

  it("open-amount bill that already got a payment is not suggested again", () => {
    expect(
      suggestMatches(
        [bill({ amount: null, reference: QRR, referenceType: "QRR" })],
        [tx({ id: "t2", reference: QRR })],
        [alloc("b1", "t1", 10000)],
      ),
    ).toEqual([]);
  });

  it("credit note is matched by reference on an incoming payment", () => {
    const s = only(
      suggestMatches(
        [bill({ kind: "credit_note", reference: SCOR, referenceType: "SCOR" })],
        [tx({ reference: SCOR, amount: minor(10000) })],
        [],
      ),
    );
    expect(s.amount).toBe(10000);
    expect(s.rule).toBe("reference");
  });

  it("does not use the reference rule for overpaid invoices", () => {
    expect(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR", creditorIban: null })],
        [tx({ id: "t2", reference: QRR, amount: minor(2000) })],
        [alloc("b1", "t1", 12000)],
      ),
    ).toEqual([]);
  });
});

describe("suggestMatches: rule 2 (IBAN + amount + window)", () => {
  // issue 2026-03-01, due 2026-03-31 -> window 2026-02-24 .. 2026-05-15
  const at = (bookingDate: string, b: Partial<MatchBill> = {}) =>
    suggestMatches([bill(b)], [tx({ bookingDate })], []);

  it("matches IBAN and exact amount inside the window", () => {
    const s = only(at("2026-03-20"));
    expect(s).toEqual({
      billId: "b1",
      transactionId: "t1",
      rule: "iban_amount",
      confidence: "high",
      amount: 10000,
      ambiguous: false,
    });
    expect(autoConfirmable(s)).toBe(false);
  });

  it("normalizes IBAN spaces and case", () => {
    expect(
      suggestMatches(
        [bill({ creditorIban: spaced(IBAN).toLowerCase() })],
        [tx({ counterpartyIban: ` ${IBAN} ` })],
        [],
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["2026-02-24", 1],
    ["2026-02-23", 0],
    ["2026-05-15", 1],
    ["2026-05-16", 0],
  ])("window edge %s -> %i", (date, count) => {
    expect(at(date)).toHaveLength(count);
  });

  it("honours custom window options", () => {
    const result = suggestMatches(
      [bill()],
      [tx({ bookingDate: "2026-05-16" })],
      [],
      {
        daysAfterDue: 46,
      },
    );
    expect(result).toHaveLength(1);
    const before = suggestMatches(
      [bill()],
      [tx({ bookingDate: "2026-02-23" })],
      [],
      {
        daysBeforeIssue: 6,
      },
    );
    expect(before).toHaveLength(1);
  });

  it("without due date the window runs to issue + 60 + 45 days (June 14)", () => {
    expect(at("2026-06-14", { dueDate: null })).toHaveLength(1);
    expect(at("2026-06-15", { dueDate: null })).toHaveLength(0);
    expect(at("2026-02-24", { dueDate: null })).toHaveLength(1);
    expect(at("2026-02-23", { dueDate: null })).toHaveLength(0);
  });

  it("without issue date the window starts at due - 60 - 5 days", () => {
    expect(at("2026-01-25", { issueDate: null })).toHaveLength(1);
    expect(at("2026-01-24", { issueDate: null })).toHaveLength(0);
    expect(at("2026-05-15", { issueDate: null })).toHaveLength(1);
    expect(at("2026-05-16", { issueDate: null })).toHaveLength(0);
  });

  it("without any date there is no rule-2 match (manual only)", () => {
    expect(at("2026-03-20", { issueDate: null, dueDate: null })).toEqual([]);
  });

  it("requires the exact amount", () => {
    expect(
      suggestMatches([bill()], [tx({ amount: minor(-9999) })], []),
    ).toEqual([]);
    expect(
      suggestMatches([bill()], [tx({ amount: minor(-10001) })], []),
    ).toEqual([]);
  });

  it("requires the same IBAN and never matches on name alone", () => {
    expect(
      suggestMatches([bill()], [tx({ counterpartyIban: OTHER_IBAN })], []),
    ).toEqual([]);
    expect(
      suggestMatches([bill()], [tx({ counterpartyIban: null })], []),
    ).toEqual([]);
    expect(suggestMatches([bill({ creditorIban: null })], [tx()], [])).toEqual(
      [],
    );
  });

  it("requires the same currency and the right direction", () => {
    expect(suggestMatches([bill()], [tx({ currency: "EUR" })], [])).toEqual([]);
    expect(
      suggestMatches([bill()], [tx({ amount: minor(10000) })], []),
    ).toEqual([]);
  });

  it("ignores cancelled and paid bills", () => {
    expect(at("2026-03-20", { cancelled: true })).toEqual([]);
    expect(
      suggestMatches([bill()], [tx({ id: "t2" })], [alloc("b1", "t1", 10000)]),
    ).toEqual([]);
  });

  it("date arithmetic crosses year ends and leap days", () => {
    const b = bill({ issueDate: "2025-12-31", dueDate: "2026-01-15" });
    // from 2025-12-26 to 2026-03-01
    const run = (d: string) =>
      suggestMatches([b], [tx({ bookingDate: d })], []).length;
    expect(run("2025-12-26")).toBe(1);
    expect(run("2025-12-25")).toBe(0);
    expect(run("2026-03-01")).toBe(1);
    expect(run("2026-03-02")).toBe(0);

    const leap = bill({ issueDate: "2024-01-10", dueDate: "2024-01-15" });
    // to 2024-02-29 (leap day)
    const runLeap = (d: string) =>
      suggestMatches([leap], [tx({ bookingDate: d })], []).length;
    expect(runLeap("2024-02-29")).toBe(1);
    expect(runLeap("2024-03-01")).toBe(0);

    const monthEnd = bill({ issueDate: null, dueDate: "2026-03-31" });
    // from 2026-03-31 - 65 days = 2026-01-25; to 2026-05-15
    expect(
      suggestMatches([monthEnd], [tx({ bookingDate: "2026-05-15" })], []),
    ).toHaveLength(1);
  });

  it("credit note is matched by IBAN and amount when money comes in", () => {
    const s = only(
      suggestMatches(
        [bill({ kind: "credit_note" })],
        [tx({ amount: minor(10000) })],
        [],
      ),
    );
    expect(s.rule).toBe("iban_amount");
    expect(s.amount).toBe(10000);
    expect(suggestMatches([bill({ kind: "credit_note" })], [tx()], [])).toEqual(
      [],
    );
  });
});

describe("suggestMatches: multi-step scenarios", () => {
  it("one bill paid by two payments: partial via reference, remaining via IBAN+amount", () => {
    const b = bill({ reference: QRR, referenceType: "QRR" });
    const first = tx({ id: "t1", reference: QRR, amount: minor(-4000) });
    const second = tx({
      id: "t2",
      bookingDate: "2026-04-05",
      amount: minor(-6000),
    });

    const s1 = only(suggestMatches([b], [first, second], []));
    expect(s1).toMatchObject({
      transactionId: "t1",
      rule: "reference",
      amount: 4000,
    });

    const allocations = [alloc("b1", "t1", 4000)];
    expect(computeBillStatus(b, allocations, "2026-04-06").status).toBe(
      "partially_paid",
    );
    const s2 = only(suggestMatches([b], [first, second], allocations));
    expect(s2).toMatchObject({
      transactionId: "t2",
      rule: "iban_amount",
      amount: 6000,
    });

    const done = [...allocations, alloc("b1", "t2", 6000)];
    expect(computeBillStatus(b, done, "2026-04-06").status).toBe("paid");
    expect(suggestMatches([b], [first, second], done)).toEqual([]);
  });

  it("overpayment becomes overpaid, the refund is suggested and settles the bill", () => {
    const b = bill();
    const payment = tx({ id: "t1", amount: minor(-12000) });
    const refund = tx({
      id: "t2",
      bookingDate: "2026-07-01",
      amount: minor(2000),
    });
    const allocations = [alloc("b1", "t1", 12000)];
    expect(computeBillStatus(b, allocations, "2026-07-02").status).toBe(
      "overpaid",
    );

    const s = only(suggestMatches([b], [payment, refund], allocations));
    expect(s).toMatchObject({
      transactionId: "t2",
      rule: "iban_amount",
      amount: -2000,
      ambiguous: false,
    });
    expect(validateAllocation(b, refund, s.amount, allocations)).toBeNull();
    const after = [...allocations, alloc("b1", "t2", s.amount)];
    expect(computeBillStatus(b, after, "2026-07-02").status).toBe("paid");
    expect(suggestMatches([b], [payment, refund], after)).toEqual([]);
  });

  it("refund suggestions require the exact surplus, IBAN, currency and incoming direction", () => {
    const allocations = [alloc("b1", "t1", 12000)];
    const run = (over: Partial<MatchTransaction>) =>
      suggestMatches(
        [bill()],
        [tx({ id: "t2", amount: minor(2000), ...over })],
        allocations,
      );
    expect(run({})).toHaveLength(1);
    expect(run({ amount: minor(1999) })).toEqual([]);
    expect(run({ counterpartyIban: OTHER_IBAN })).toEqual([]);
    expect(run({ counterpartyIban: null })).toEqual([]);
    expect(run({ currency: "EUR" })).toEqual([]);
    expect(run({ amount: minor(-2000) })).toEqual([]);
    expect(
      suggestMatches(
        [bill({ creditorIban: null })],
        [tx({ id: "t2", amount: minor(2000) })],
        allocations,
      ),
    ).toEqual([]);
    expect(
      suggestMatches(
        [bill({ amount: null })],
        [tx({ id: "t2", amount: minor(2000) })],
        allocations,
      ),
    ).toEqual([]);
  });

  it("credit note: credit_due, refund arrives, paid", () => {
    const b = bill({ kind: "credit_note", amount: minor(3500), dueDate: null });
    const refund = tx({
      id: "t9",
      bookingDate: "2026-03-25",
      amount: minor(3500),
    });
    expect(computeBillStatus(b, [], "2026-03-25").status).toBe("credit_due");
    const s = only(suggestMatches([b], [refund], []));
    expect(s.amount).toBe(3500);
    const allocations = [alloc("b1", "t9", s.amount)];
    expect(computeBillStatus(b, allocations, "2026-03-26").status).toBe("paid");
    expect(suggestMatches([b], [refund], allocations)).toEqual([]);
  });

  it("overpaid credit notes are not suggested", () => {
    expect(
      suggestMatches(
        [bill({ kind: "credit_note" })],
        [tx({ id: "t2", amount: minor(100) })],
        [alloc("b1", "t1", 10100)],
      ),
    ).toEqual([]);
  });

  it("cancelled bill with allocations stays cancelled and is never suggested", () => {
    const b = bill({ cancelled: true, reference: QRR, referenceType: "QRR" });
    const allocations = [alloc("b1", "t1", 10000)];
    expect(computeBillStatus(b, allocations, "2026-04-01").status).toBe(
      "cancelled",
    );
    expect(suggestMatches([b], [tx({ id: "t2", reference: QRR })], [])).toEqual(
      [],
    );
  });

  it("a paid-out transaction is not suggested, a partly free one is", () => {
    const b1 = bill({ id: "b1", amount: minor(6000) });
    const b2 = bill({
      id: "b2",
      amount: minor(4000),
      reference: QRR,
      referenceType: "QRR",
    });
    const payment = tx({ reference: QRR });
    const full = [alloc("b1", "t1", 10000)];
    expect(suggestMatches([b2], [payment], full)).toEqual([]);

    const partial = [alloc("b1", "t1", 6000)];
    const s = only(suggestMatches([b1, b2], [payment], partial));
    expect(s).toMatchObject({ billId: "b2", amount: 4000, rule: "reference" });
  });

  it("IBAN+amount compares against the unallocated part", () => {
    const b2 = bill({ id: "b2", amount: minor(4000) });
    const s = only(suggestMatches([b2], [tx()], [alloc("b1", "t1", 6000)]));
    expect(s.billId).toBe("b2");
    expect(s.amount).toBe(4000);
  });

  it("does not re-suggest an already allocated pair", () => {
    const b = bill({ reference: QRR, referenceType: "QRR" });
    const payment = tx({ reference: QRR, amount: minor(-4000) });
    expect(suggestMatches([b], [payment], [alloc("b1", "t1", 4000)])).toEqual(
      [],
    );
  });

  it("ignores zero-amount transactions", () => {
    expect(
      suggestMatches(
        [bill({ reference: QRR, referenceType: "QRR" })],
        [tx({ amount: minor(0), reference: QRR })],
        [],
      ),
    ).toEqual([]);
  });
});

describe("suggestMatches: ambiguity and precedence", () => {
  it("two identical bills and one payment are ambiguous", () => {
    const result = suggestMatches(
      [bill({ id: "b1" }), bill({ id: "b2" })],
      [tx()],
      [],
    );
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.ambiguous)).toBe(true);
    expect(result.some(autoConfirmable)).toBe(false);
  });

  it("two identical payments and one bill are ambiguous", () => {
    const result = suggestMatches(
      [bill()],
      [tx({ id: "t1" }), tx({ id: "t2", bookingDate: "2026-03-21" })],
      [],
    );
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.ambiguous)).toBe(true);
  });

  it("ambiguous reference matches are not auto-confirmable", () => {
    const result = suggestMatches(
      [
        bill({ id: "b1", reference: QRR, referenceType: "QRR" }),
        bill({ id: "b2", reference: QRR, referenceType: "QRR" }),
      ],
      [tx({ reference: QRR })],
      [],
    );
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.ambiguous && !autoConfirmable(s))).toBe(true);
  });

  it("unrelated suggestions stay unambiguous", () => {
    const result = suggestMatches(
      [
        bill({ id: "b1", amount: minor(10000) }),
        bill({ id: "b2", amount: minor(2500), creditorIban: OTHER_IBAN }),
      ],
      [
        tx({ id: "t1" }),
        tx({ id: "t2", amount: minor(-2500), counterpartyIban: OTHER_IBAN }),
      ],
      [],
    );
    expect(result).toHaveLength(2);
    expect(result.every((s) => !s.ambiguous)).toBe(true);
  });

  it("rule 1 beats rule 2 for the same transaction", () => {
    const refBill = bill({
      id: "b1",
      reference: QRR,
      referenceType: "QRR",
      creditorIban: OTHER_IBAN,
    });
    const ibanBill = bill({ id: "b2" });
    const result = suggestMatches(
      [refBill, ibanBill],
      [tx({ reference: QRR })],
      [],
    );
    const s = only(result);
    expect(s).toMatchObject({
      billId: "b1",
      rule: "reference",
      ambiguous: false,
    });
  });

  it("a bill can match by reference and by IBAN for different transactions", () => {
    const b = bill({ reference: QRR, referenceType: "QRR" });
    const result = suggestMatches(
      [b],
      [
        tx({ id: "t1", reference: QRR, amount: minor(-10000) }),
        tx({ id: "t2", amount: minor(-10000), bookingDate: "2026-03-21" }),
      ],
      [],
    );
    // combined 20000 exceeds the remaining 10000: the user must decide
    expect(result.map((s) => [s.transactionId, s.rule, s.ambiguous])).toEqual([
      ["t1", "reference", true],
      ["t2", "iban_amount", true],
    ]);
  });

  it("rule-2 is ambiguous on a bill that also has a reference match, the reference one stays if both fit", () => {
    const b = bill({ reference: QRR, referenceType: "QRR" });
    const result = suggestMatches(
      [b],
      [
        tx({ id: "t1", reference: QRR, amount: minor(-4000) }),
        tx({ id: "t2", amount: minor(-6000), bookingDate: "2026-03-21" }),
      ],
      [],
    );
    // t2 (6000) does not equal remaining (10000): no rule-2, reference stays exact
    expect(result.map((s) => [s.transactionId, s.rule, s.ambiguous])).toEqual([
      ["t1", "reference", false],
    ]);
    const after = suggestMatches(
      [b],
      [
        tx({ id: "t1", reference: QRR, amount: minor(-4000) }),
        tx({ id: "t2", amount: minor(-6000), bookingDate: "2026-03-21" }),
      ],
      [alloc("b1", "t1", 4000)],
    );
    expect(after.map((s) => [s.transactionId, s.rule, s.ambiguous])).toEqual([
      ["t2", "iban_amount", false],
    ]);
  });

  it("a partial reference match leaves the rest of the payment for IBAN+amount on another bill", () => {
    const refBill = bill({
      id: "b1",
      amount: minor(6000),
      reference: QRR,
      referenceType: "QRR",
      creditorIban: OTHER_IBAN,
    });
    const ibanBill = bill({ id: "b2", amount: minor(4000) });
    const result = suggestMatches(
      [refBill, ibanBill],
      [tx({ reference: QRR, amount: minor(-10000) })],
      [],
    );
    expect(
      result.map((s) => [s.billId, s.rule, s.amount, s.ambiguous]),
    ).toEqual([
      ["b1", "reference", 6000, false],
      ["b2", "iban_amount", 4000, false],
    ]);
    // the full payment no longer matches the IBAN bill
    expect(
      suggestMatches(
        [refBill, bill({ id: "b2", amount: minor(10000) })],
        [tx({ reference: QRR, amount: minor(-10000) })],
        [],
      ).map((s) => s.billId),
    ).toEqual(["b1"]);
  });

  it("does not crash on malformed dates and skips rule 2 for that bill", () => {
    for (const bad of ["2026-13-45", "garbage", "2026-02-30", ""]) {
      expect(suggestMatches([bill({ dueDate: bad })], [tx()], [])).toEqual([]);
      expect(suggestMatches([bill({ issueDate: bad })], [tx()], [])).toEqual(
        [],
      );
    }
    const ref = bill({
      dueDate: "garbage",
      reference: QRR,
      referenceType: "QRR",
    });
    expect(
      suggestMatches([ref], [tx({ reference: QRR })], []).map((s) => s.rule),
    ).toEqual(["reference"]);
  });
});

describe("suggestMatches: ordering", () => {
  it("sorts by due date (nulls last), bill id, booking date, transaction id", () => {
    const bills = [
      bill({
        id: "c",
        dueDate: null,
        issueDate: "2026-03-01",
        creditorIban: OTHER_IBAN,
        amount: minor(300),
      }),
      bill({
        id: "b",
        dueDate: "2026-04-01",
        creditorIban: OTHER_IBAN,
        amount: minor(200),
      }),
      bill({
        id: "a",
        dueDate: "2026-04-01",
        creditorIban: OTHER_IBAN,
        amount: minor(200),
      }),
      bill({
        id: "z",
        dueDate: "2026-03-01",
        creditorIban: OTHER_IBAN,
        amount: minor(100),
      }),
    ];
    const txs = [
      tx({
        id: "t3",
        bookingDate: "2026-03-10",
        amount: minor(-200),
        counterpartyIban: OTHER_IBAN,
      }),
      tx({
        id: "t2",
        bookingDate: "2026-03-11",
        amount: minor(-200),
        counterpartyIban: OTHER_IBAN,
      }),
      tx({
        id: "t1",
        bookingDate: "2026-03-10",
        amount: minor(-200),
        counterpartyIban: OTHER_IBAN,
      }),
      tx({
        id: "t4",
        bookingDate: "2026-03-12",
        amount: minor(-100),
        counterpartyIban: OTHER_IBAN,
      }),
      tx({
        id: "t5",
        bookingDate: "2026-03-12",
        amount: minor(-300),
        counterpartyIban: OTHER_IBAN,
      }),
    ];
    const result = suggestMatches(bills, txs, []);
    expect(result.map((s) => `${s.billId}:${s.transactionId}`)).toEqual([
      "z:t4",
      "a:t1",
      "a:t3",
      "a:t2",
      "b:t1",
      "b:t3",
      "b:t2",
      "c:t5",
    ]);
    const reversed = suggestMatches(
      [...bills].reverse(),
      [...txs].reverse(),
      [],
    );
    expect(reversed).toEqual(result);
  });
});

describe("autoConfirmable", () => {
  const base: Suggestion = {
    billId: "b",
    transactionId: "t",
    rule: "reference",
    confidence: "exact",
    amount: 1 as Minor,
    ambiguous: false,
  };
  it("is true only for unambiguous reference matches", () => {
    expect(autoConfirmable(base)).toBe(true);
    expect(autoConfirmable({ ...base, ambiguous: true })).toBe(false);
    expect(
      autoConfirmable({ ...base, rule: "iban_amount", confidence: "high" }),
    ).toBe(false);
  });
});
