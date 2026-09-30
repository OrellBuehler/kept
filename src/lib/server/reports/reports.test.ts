import { describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { minor } from "$lib/money";
import { daysBetween } from "$lib/server/bills/status";
import { allocate } from "$lib/server/bills/allocations";
import { billViews } from "$lib/server/bills/status";
import { LedgerError } from "$lib/server/ledger/errors";
import { createSnapshot } from "$lib/server/ledger";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  accountStatementReport,
  billsReport,
  buildReport,
  loadAccountStatement,
  loadBillsReport,
  loadNetWorthReport,
  netWorthReport,
  type AccountStatementInput,
} from "./index";

const TODAY = "2026-10-15";
const m = minor;

async function textOf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text.replace(/\s+/g, " ");
}

const statementInput = (): AccountStatementInput => ({
  account: {
    name: "Household",
    institutionName: "Example Institution",
    ibanMasked: "CH93 •••• •••• •••• 2957",
    currency: "CHF",
  },
  from: "2026-09-01",
  to: "2026-09-30",
  openingBalance: m(100000),
  closingBalance: m(98500),
  transactions: [
    {
      bookingDate: "2026-09-03",
      counterpartyName: "Example Shop",
      description: "Groceries",
      amount: m(-2500),
    },
    {
      bookingDate: "2026-09-25",
      counterpartyName: null,
      description: null,
      amount: m(1000),
    },
  ],
  generatedOn: TODAY,
});

describe("report builders", () => {
  it("renders an account statement with the expected labels", async () => {
    const bytes = await accountStatementReport(statementInput());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(2000);
    const text = await textOf(bytes);
    for (const s of [
      "Household",
      "CH93 •••• •••• •••• 2957",
      "Statement from 2026-09-01 to 2026-09-30",
      "Opening balance",
      "Closing balance",
      "Example Shop",
      "Groceries",
      "2026-09-03",
      "Page 1 of 1",
      `Generated ${TODAY}`,
    ]) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain(EXAMPLE_IBAN);
  });

  it("notes a balance adjustment only when the figures do not reconcile", async () => {
    // opening 100000 - 2500 + 1000 = 98500 reconciles
    expect(
      await textOf(await accountStatementReport(statementInput())),
    ).not.toContain("Adjusted by balance snapshot");
    const text = await textOf(
      await accountStatementReport({
        ...statementInput(),
        closingBalance: m(99000),
      }),
    );
    expect(text).toContain("Adjusted by balance snapshot: CHF 5.00");
  });

  it("is deterministic for the same input", async () => {
    const a = await accountStatementReport(statementInput());
    const b = await accountStatementReport(statementInput());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await accountStatementReport({
      ...statementInput(),
      generatedOn: "2026-10-16",
    });
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("handles empty periods and many pages", async () => {
    const empty = await accountStatementReport({
      ...statementInput(),
      transactions: [],
    });
    expect(await textOf(empty)).toContain("No transactions in this period.");

    const many = await accountStatementReport({
      ...statementInput(),
      transactions: Array.from({ length: 200 }, (_, i) => ({
        bookingDate: "2026-09-10",
        counterpartyName: `Payee ${i}`,
        description: "Monthly payment with a fairly long description text",
        amount: m(-(i + 1)),
      })),
    });
    const text = await textOf(many);
    expect(text).toMatch(/Page 1 of [2-9]/);
    expect(text).toContain("Payee 199");
  });

  it("renders bills grouped with totals per currency", async () => {
    const base = {
      kind: "invoice" as const,
      id: "x",
    };
    void base;
    const views = [
      {
        name: "Overdue Supplier",
        due: "2026-10-01",
        amount: 12000,
        cur: "CHF",
      },
      { name: "Soon Supplier", due: "2026-10-20", amount: 3000, cur: "CHF" },
      { name: "Euro Supplier", due: "2026-10-01", amount: 500, cur: "EUR" },
    ];
    const userless = views.map((v, i) => ({
      id: String(i),
      kind: "invoice" as const,
      creditorName: v.name,
      creditorIban: null,
      amount: m(v.amount),
      currency: v.cur,
      issueDate: null,
      dueDate: v.due,
      reference: null,
      referenceType: null,
      message: null,
      invoiceNumber: `INV-${i}`,
      cancelled: false,
      documentId: null,
      expectedAccountId: null,
      notes: null,
      taxYear: null,
      externalSource: null,
      externalRef: null,
      externalUrl: null,
      extraction: null,
      createdAt: 0,
      updatedAt: 0,
      status: "open" as const,
      settled: m(0),
      remaining: m(v.amount),
      overdue: v.due < TODAY,
      dueInDays: daysBetween(TODAY, v.due),
      lastPaymentDate: null,
      allocationCount: 0,
    }));
    const bytes = await billsReport({ bills: userless, asOf: TODAY });
    const text = await textOf(bytes);
    for (const s of [
      "Overdue (2)",
      "Due within 14 days (1)",
      "Overdue Supplier",
      "INV-1",
      "Totals",
      "EUR",
    ]) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain("Awaiting refund");
    expect(
      await textOf(await billsReport({ bills: [], asOf: TODAY })),
    ).toContain("No open bills.");
  });

  it("renders net worth balances and history", async () => {
    const bytes = await netWorthReport({
      asOf: TODAY,
      balances: [
        {
          name: "Everyday",
          type: "current",
          currency: "CHF",
          ibanMasked: null,
          balance: m(1000),
          institution: { name: "Example Institution" },
        },
        {
          name: "Pension",
          type: "pension",
          currency: "CHF",
          ibanMasked: null,
          balance: m(2000),
          institution: null,
        },
      ],
      series: [
        {
          currency: "CHF",
          points: [
            { date: "2026-09-30", amount: m(2500) },
            { date: TODAY, amount: m(3000) },
          ],
        },
      ],
    });
    const text = await textOf(bytes);
    for (const s of [
      "Net worth",
      "Accounts in CHF",
      "Everyday",
      "Pension",
      "Total",
      "History",
      "2026-09-30",
    ]) {
      expect(text, s).toContain(s);
    }
  });
});

describe("loaders and buildReport", () => {
  useTestDB();

  it("loads a statement with opening and closing balances", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, {
      name: "Household",
      iban: EXAMPLE_IBAN,
      openingBalance: m(10000),
      openingDate: "2026-01-01",
    });
    const tx = (bookingDate: string, amount: number) =>
      seedImportedTransaction(u.id, a.id, { bookingDate, amount: m(amount) });
    tx("2026-08-31", -100);
    tx("2026-09-01", -200);
    tx("2026-09-30", 500);
    tx("2026-10-01", -999);
    const s = loadAccountStatement(
      u.id,
      a.id,
      "2026-09-01",
      "2026-09-30",
      TODAY,
    );
    expect(s.openingBalance).toBe(9900);
    expect(s.closingBalance).toBe(10200);
    expect(s.transactions.map((t) => t.amount)).toEqual([-200, 500]);
    expect(s.account.ibanMasked).toContain("•");
    expect(s.account.ibanMasked).not.toBe(EXAMPLE_IBAN);
  });

  it("uses snapshots for balances", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, { type: "pension" });
    createSnapshot(u.id, a.id, {
      date: "2026-08-31",
      amount: m(5000),
    } as never);
    createSnapshot(u.id, a.id, {
      date: "2026-09-30",
      amount: m(5600),
    } as never);
    const s = loadAccountStatement(
      u.id,
      a.id,
      "2026-09-01",
      "2026-09-30",
      TODAY,
    );
    expect(s.openingBalance).toBe(5000);
    expect(s.closingBalance).toBe(5600);
  });

  it("rejects inverted periods and other users' accounts", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const mine = seedAccount(u.id);
    const theirs = seedAccount(other.id);
    expect(() =>
      loadAccountStatement(u.id, mine.id, "2026-09-30", "2026-09-01", TODAY),
    ).toThrow(LedgerError);
    await expect(
      buildReport(
        u.id,
        "statement",
        { account: theirs.id, from: "2026-09-01", to: "2026-09-30" },
        TODAY,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates statement params", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id);
    const bad = (params: Record<string, string | null>) =>
      expect(
        buildReport(u.id, "statement", params, TODAY),
      ).rejects.toMatchObject({ code: "invalid" });
    await bad({});
    await bad({ account: a.id, from: "2026-13-01", to: "2026-09-30" });
    await bad({ account: a.id, from: "2026-09-01", to: "tomorrow" });
    await bad({ account: a.id, from: "2026-09-01" });
  });

  it("builds every kind with file name and title", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, { name: "Household" });
    seedBill(u.id, { dueDate: "2026-10-01" });
    const statement = await buildReport(
      u.id,
      "statement",
      { account: a.id, from: "2026-09-01", to: "2026-09-30" },
      TODAY,
    );
    expect(statement.fileName).toBe("kept-statement-2026-10-15.pdf");
    expect(statement.title).toContain("Household");
    const bills = await buildReport(u.id, "bills", {}, TODAY);
    expect(bills.fileName).toBe("kept-bills-2026-10-15.pdf");
    expect(await textOf(bills.bytes)).toContain("Overdue (1)");
    const nw = await buildReport(u.id, "net-worth", {}, TODAY);
    expect(nw.fileName).toBe("kept-net-worth-2026-10-15.pdf");
    expect(await textOf(nw.bytes)).toContain("Household");
  });

  it("bills and net worth reports only contain the user's own data", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    seedAccount(other.id, { name: "Foreign Account" });
    seedBill(other.id, {
      creditorName: "Foreign Creditor",
      dueDate: "2026-10-01",
    });
    seedBill(u.id, { creditorName: "Own Creditor", dueDate: "2026-10-01" });
    expect(loadBillsReport(u.id, TODAY).bills).toHaveLength(1);
    expect(loadNetWorthReport(u.id, TODAY).balances).toEqual([]);
    const bills = await textOf(
      (await buildReport(u.id, "bills", {}, TODAY)).bytes,
    );
    expect(bills).toContain("Own Creditor");
    expect(bills).not.toContain("Foreign Creditor");
    const nw = await textOf(
      (await buildReport(u.id, "net-worth", {}, TODAY)).bytes,
    );
    expect(nw).not.toContain("Foreign Account");
  });

  it("bills report reflects allocations (paid bills drop out)", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id);
    const bill = seedBill(u.id, { amount: m(1000), dueDate: "2026-10-01" });
    const tx = seedImportedTransaction(u.id, a.id, {
      bookingDate: "2026-10-02",
      amount: m(-1000),
    });
    allocate(u.id, bill.id, tx.id, m(1000), "user");
    expect(billViews(u.id, { today: TODAY })[0]!.status).toBe("paid");
    const text = await textOf(
      (await buildReport(u.id, "bills", {}, TODAY)).bytes,
    );
    expect(text).toContain("No open bills.");
  });
});
