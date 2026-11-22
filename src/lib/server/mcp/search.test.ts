import { afterEach, describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { candidateTransactions } from "$lib/server/bills/candidates";
import { billViews } from "$lib/server/bills/status";
import { filterBills } from "$lib/server/bills/list";
import { apiAuthFailureLimiter } from "$lib/server/external-api/gate";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedToken } from "$lib/testing/external-api";
import {
  EXAMPLE_IBAN,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { callTool } from "$lib/testing/mcp";
import { mcpTokenLimiter } from "./gate";

afterEach(() => {
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

const MESSAGE = "zebra-message-text";
const PAYMENT_REFERENCE = "REF-QUOKKA-77";

async function seed() {
  const user = await createTestUser();
  const account = await seedAccount(user.id);
  const bill = await seedBill(user.id, {
    creditorName: "Visible Creditor",
    creditorIban: EXAMPLE_IBAN,
    reference: EXAMPLE_QRR,
    referenceType: "QRR",
    message: MESSAGE,
    notes: "kangaroo-note",
    amount: minor(5000),
  });
  const payment = await seedImportedTransaction(user.id, account.id, {
    counterpartyName: "Visible Payee",
    description: "visible text",
    reference: PAYMENT_REFERENCE,
    amount: minor(-5000),
  });
  const { token } = await seedToken(user.id, [
    "bills:read",
    "transactions:read",
  ]);
  return { user, bill, payment, token };
}

describe("mcp tools: search covers only what a tool returns", () => {
  useTestDB();

  it("list_bills finds a bill by creditor, invoice number, notes or amount, but not by IBAN, reference or message", async () => {
    const { token, bill } = await seed();
    const ids = async (q: string) => {
      const r = await callTool(token, "list_bills", { q });
      expect(r.isError, r.text).toBe(false);
      return (r.data.items as { id: string }[]).map((i) => i.id);
    };
    expect(await ids("visible creditor")).toEqual([bill.id]);
    expect(await ids("kangaroo")).toEqual([bill.id]);
    expect(await ids("50.00")).toEqual([bill.id]);
    // Prefixes of what no tool returns recover nothing.
    expect(await ids(EXAMPLE_IBAN.slice(0, 8))).toEqual([]);
    expect(await ids(EXAMPLE_IBAN)).toEqual([]);
    expect(await ids(EXAMPLE_QRR.slice(0, 10))).toEqual([]);
    expect(await ids(EXAMPLE_QRR)).toEqual([]);
    expect(await ids("zebra")).toEqual([]);
  });

  it("the web search still finds a bill by IBAN, reference and message", async () => {
    const { user, bill } = await seed();
    const views = await billViews(user.id, { today: "2026-01-01" });
    for (const q of [EXAMPLE_IBAN.slice(0, 8), EXAMPLE_QRR, "zebra"]) {
      expect(
        filterBills(views, { q, status: "all" }).map((v) => v.id),
        q,
      ).toEqual([bill.id]);
    }
    expect(
      filterBills(
        views,
        { q: EXAMPLE_QRR, status: "all" },
        { returnedFieldsOnly: true },
      ),
    ).toEqual([]);
  });

  it("list_payment_candidates finds a payment by counterparty, description or amount, but not by its reference", async () => {
    const { token, bill, payment } = await seed();
    const ids = async (q: string) => {
      const r = await callTool(token, "list_payment_candidates", {
        billId: bill.id,
        q,
      });
      expect(r.isError, r.text).toBe(false);
      return (r.data.items as { paymentId: string }[]).map((i) => i.paymentId);
    };
    expect(await ids("visible payee")).toEqual([payment.id]);
    expect(await ids("visible text")).toEqual([payment.id]);
    expect(await ids("50.00")).toEqual([payment.id]);
    expect(await ids("QUOKKA")).toEqual([]);
    expect(await ids(PAYMENT_REFERENCE)).toEqual([]);
  });

  it("the web candidate search still finds a payment by its reference", async () => {
    const { user, bill, payment } = await seed();
    const web = await candidateTransactions(user.id, bill.id, {
      q: "QUOKKA",
    });
    expect(web.items.map((t) => t.id)).toEqual([payment.id]);
    const mcp = await candidateTransactions(user.id, bill.id, {
      q: "QUOKKA",
      returnedFieldsOnly: true,
    });
    expect(mcp.items).toEqual([]);
  });
});
