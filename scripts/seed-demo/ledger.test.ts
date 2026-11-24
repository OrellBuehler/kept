import { describe, expect, it } from "vitest";
import { isValidIban } from "../../src/lib/iban";
import { parseAmount } from "../../src/lib/money";
import { isValidQrr, isValidScor } from "../../src/lib/references";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
  FOREIGN_IBANS,
} from "../../src/lib/testing/fixtures/bill-identifiers";
import { ACCOUNTS, plannedItems, taxCredits } from "./dataset";
import {
  HISTORY_START,
  IBANS,
  WALLET_OPENING,
  addMonths,
  between,
  buildLedger,
  lastDay,
  monthsUpTo,
  plain,
  qrr,
  scor,
  type Entry,
} from "./ledger";

const TODAY = "2026-11-24";
const opening = (key: string) =>
  parseAmount(ACCOUNTS.find((a) => a.key === key)!.openingBalance);

const lists = (today: string) => {
  const ledger = buildLedger(today);
  return [ledger.checking, ledger.savings, ledger.wallet];
};

describe("buildLedger", () => {
  it("gives the same answer for the same day", () => {
    expect(buildLedger(TODAY)).toEqual(buildLedger(TODAY));
  });

  it("keeps every record and id of an earlier day on a later one", () => {
    const earlier = buildLedger("2026-06-15");
    const later = buildLedger("2026-11-24");
    for (const key of ["checking", "savings", "wallet"] as const) {
      const byId = new Map(later[key].map((e) => [e.id, e]));
      expect(earlier[key].length).toBeGreaterThan(0);
      for (const e of earlier[key]) expect(byId.get(e.id)).toEqual(e);
    }
    const bills = new Map(later.bills.map((b) => [b.invoiceNumber, b]));
    for (const b of earlier.bills) {
      const same = bills.get(b.invoiceNumber)!;
      expect({ ...same, payment: null }).toEqual({ ...b, payment: null });
    }
  });

  it("never dates anything before the history or after today", () => {
    for (const today of ["2026-01-02", "2026-03-31", TODAY, "2027-05-09"]) {
      for (const list of lists(today)) {
        for (const e of list) {
          expect(e.date >= HISTORY_START).toBe(true);
          expect(e.date <= today).toBe(true);
        }
      }
    }
  });

  it("is empty before the history starts", () => {
    const ledger = buildLedger("2025-12-31");
    expect(ledger.checking).toEqual([]);
    expect(ledger.bills).toEqual([]);
  });

  it("uses an id once per account and only whole minor units", () => {
    for (const list of lists("2027-08-30")) {
      expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
      for (const e of list) {
        expect(Number.isInteger(e.amount)).toBe(true);
        expect(e.amount).not.toBe(0);
        expect(e.id.startsWith("DEMO-")).toBe(true);
      }
    }
  });

  it("covers roughly the months up to today", () => {
    const dates = buildLedger(TODAY).checking.map((e) => e.date);
    expect(dates[0]!.slice(0, 7)).toBe("2026-01");
    expect(dates[dates.length - 1]!.slice(0, 7)).toBe("2026-11");
    expect(monthsUpTo(TODAY)).toHaveLength(11);
  });

  it("keeps every balance healthy", () => {
    for (const today of ["2026-02-10", "2026-07-01", TODAY, "2027-03-03"]) {
      const ledger = buildLedger(today);
      for (const [list, start, floor] of [
        [ledger.checking, opening("checking"), 500_000],
        [ledger.savings, opening("savings"), 0],
        [ledger.wallet, WALLET_OPENING, 0],
      ] as const) {
        let balance: number = start;
        for (const e of list) {
          balance += e.amount;
          expect(balance).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it("moves money between own accounts in matching pairs", () => {
    const { checking, savings, wallet } = buildLedger(TODAY);
    const pairs: [Entry[], string, Entry[], string][] = [
      [checking, IBANS.savings, savings, IBANS.checking],
      [checking, IBANS.wallet, wallet, IBANS.checking],
    ];
    for (const [from, toIban, to, fromIban] of pairs) {
      const out = from.filter((e) => e.counterpartyIban === toIban);
      const incoming = to.filter((e) => e.counterpartyIban === fromIban);
      expect(out.length).toBeGreaterThan(0);
      expect(incoming.map((e) => [e.date, e.amount])).toEqual(
        out.map((e) => [e.date, -e.amount]),
      );
    }
  });

  it("pairs every paid bill with one payment carrying its reference", () => {
    const ledger = buildLedger(TODAY);
    const references = ledger.bills.map((b) => b.reference);
    expect(new Set(references).size).toBe(references.length);
    expect(new Set(ledger.bills.map((b) => b.invoiceNumber)).size).toBe(
      ledger.bills.length,
    );
    for (const bill of ledger.bills) {
      expect(isValidScor(bill.reference)).toBe(true);
      expect(bill.dueDate >= bill.issueDate).toBe(true);
      const payments = ledger.checking.filter(
        (e) => e.reference === bill.reference,
      );
      if (!bill.payment) {
        expect(payments).toEqual([]);
        continue;
      }
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        date: bill.payment.date,
        amount: -bill.payment.amount,
        counterparty: bill.creditor,
      });
    }
  });

  it("shows bills in every state at the day the history was designed for", () => {
    const { bills } = buildLedger(TODAY);
    const state = (b: (typeof bills)[number]) =>
      !b.payment
        ? b.dueDate < TODAY
          ? "overdue"
          : "open"
        : b.payment.amount < b.amount
          ? "partial"
          : "paid";
    const states = new Set(bills.map(state));
    expect(states).toEqual(new Set(["overdue", "open", "partial", "paid"]));
    expect(bills.filter((b) => b.document).length).toBeGreaterThanOrEqual(3);
  });

  it("adds the next quarter's invoices once their day has come", () => {
    const before = buildLedger("2027-01-11").bills.map((b) => b.invoiceNumber);
    const after = buildLedger("2027-01-13").bills.map((b) => b.invoiceNumber);
    expect(before).not.toContain("EEU-2027-01");
    expect(after).toContain("EEU-2027-01");
  });

  it("uses only invented names and documented example IBANs", () => {
    const documented = new Set([
      EXAMPLE_IBAN,
      EXAMPLE_IBAN_OTHER,
      EXAMPLE_IBAN_THIRD,
      ...FOREIGN_IBANS,
    ]);
    const ledger = buildLedger("2027-12-31");
    const own = ["Everyday account", "Rainy-day savings", "Cash withdrawal"];
    for (const list of lists("2027-12-31")) {
      for (const e of list) {
        expect(
          e.counterparty.startsWith("Example ") || own.includes(e.counterparty),
        ).toBe(true);
        if (e.counterpartyIban)
          expect(documented.has(e.counterpartyIban)).toBe(true);
      }
    }
    for (const bill of ledger.bills) expect(bill.creditor).toMatch(/^Example /);
    for (const account of ACCOUNTS) {
      for (const iban of [account.iban, account.depositIban]) {
        if (iban) expect(documented.has(iban) && isValidIban(iban)).toBe(true);
      }
    }
  });
});

describe("references", () => {
  it("builds valid creditor and QR references", () => {
    for (const body of ["1", "ABC123", "2026011212", "3A260001042"]) {
      expect(isValidScor(scor(body))).toBe(true);
    }
    for (const digits of ["1", "260001042", "99999999999999999999999999"]) {
      expect(isValidQrr(qrr(digits))).toBe(true);
    }
  });
});

describe("dates", () => {
  it("adds months and finds month ends", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(lastDay("2027-02")).toBe("2027-02-28");
    expect(lastDay("2028-02")).toBe("2028-02-29");
  });

  it("draws the same number for the same seed", () => {
    expect(between("a", 1, 1000)).toBe(between("a", 1, 1000));
    expect(between("a", 5, 5)).toBe(5);
    const draws = new Set(
      Array.from({ length: 50 }, (_, i) => between(`s${i}`, 0, 9)),
    );
    expect(draws.size).toBeGreaterThan(5);
  });

  it("writes minor units as plain decimals", () => {
    expect(plain(185_000)).toBe("1850.00");
    expect(plain(-5)).toBe("-0.05");
    expect(plain(0)).toBe("0.00");
  });
});

describe("planned items and tax credits", () => {
  it("plans in the months ahead, whatever the day", () => {
    for (const today of ["2026-11-01", "2026-11-30", "2026-12-31"]) {
      for (const item of plannedItems(today)) {
        expect(item.date > today).toBe(true);
      }
    }
    expect(plannedItems("2026-12-31").map((i) => i.date)).toEqual([
      "2027-01-03",
      "2027-01-15",
      "2027-02-20",
    ]);
  });

  it("credits each paid tax invoice once, the day after the payment", () => {
    const ledger = buildLedger(TODAY);
    const credits = taxCredits(ledger.bills);
    expect(credits.map((c) => c.year)).toEqual([2025, 2026, 2026, 2026]);
    for (const credit of credits) {
      const bill = ledger.bills.find((b) => b.reference === credit.reference)!;
      expect(credit.amount).toBe(plain(bill.payment!.amount));
      expect(credit.bookingDate > bill.payment!.date).toBe(true);
    }
  });
});
