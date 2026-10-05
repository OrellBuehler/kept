import { describe, expect, it } from "vitest";
import { pdfText } from "$lib/testing/pdf";
import { minor } from "$lib/money";
import { LedgerError } from "$lib/server/ledger/errors";
import {
  addTaxCredit,
  setTransactionTaxYear,
  upsertTaxYear,
} from "$lib/server/tax/tax";
import {
  taxCreditInputSchema,
  taxYearInputSchema,
} from "$lib/server/tax/schemas";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { buildReport } from "./index";

const TODAY = "2026-10-15";

describe("tax report", () => {
  useTestDB();

  it("renders the reconciliation with its discrepancies", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    const tx = await seedImportedTransaction(user.id, account.id, {
      amount: minor(-100000),
      bookingDate: "2025-03-10",
    });
    await setTransactionTaxYear(user.id, tx.id, 2025);
    await upsertTaxYear(
      user.id,
      taxYearInputSchema.parse({
        year: "2025",
        currency: "CHF",
        authority: "Example Tax Office",
        assessedTotal: "3000.00",
      }),
    );
    await addTaxCredit(
      user.id,
      2025,
      taxCreditInputSchema("CHF").parse({
        bookingDate: "2025-09-01",
        amount: "400.00",
      }),
    );

    const built = await buildReport(user.id, "tax", { year: "2025" }, TODAY);
    expect(built.fileName).toBe("kept-tax-2025-2026-10-15.pdf");
    expect(built.title).toBe("Tax 2025 reconciliation");
    const text = await pdfText(built.bytes);
    expect(text).toContain("Example Tax Office");
    expect(text).toContain("Not counted by tax office");
    expect(text).toContain("Not in your payments");
    expect(text).toContain("Still due");
  });

  it("rejects a missing year and hides other users' years", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const account = await seedAccount(a.id);
    await setTransactionTaxYear(
      a.id,
      (
        await seedImportedTransaction(a.id, account.id, {
          amount: minor(-1000),
        })
      ).id,
      2025,
    );

    const missing = await buildReport(a.id, "tax", {}, TODAY).catch((e) => e);
    expect(missing).toBeInstanceOf(LedgerError);
    expect((missing as LedgerError).field).toBe("year");
    const foreign = await buildReport(
      b.id,
      "tax",
      { year: "2025" },
      TODAY,
    ).catch((e) => e);
    expect((foreign as LedgerError).code).toBe("not_found");
  });
});
