/**
 * Saving account settings unsets the other default payment accounts of the
 * currency, so overlapping saves of one user take turns on the ledger lock, which also guards the account's currency.
 */
import { describe, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import { seedAccount } from "$lib/testing/ledger";
import { saveAccountSettings } from "./settings";

useTestDB();

describe("forecast", () => {
  it("saving account settings takes the user's ledger lock", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id);
    await expectHeldBy(`ledger:${user.id}`, () =>
      saveAccountSettings(user.id, {
        accountId: account.id,
        defaultPayment: "on",
      }),
    );
  });
});
