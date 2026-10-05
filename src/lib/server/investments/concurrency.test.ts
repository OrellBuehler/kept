/**
 * Trades and manual prices rely on their security (its currency, that it exists)
 * and on their account's currency, and check them in their own transactions, so
 * changing or deleting either takes the same per-user ledger lock.
 */
import { describe, it } from "vitest";
import { minor } from "$lib/money";
import { parseFixed } from "$lib/quantity";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedSecurity } from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import { expectHeldBy } from "$lib/testing/locks";
import {
  createTrade,
  deleteSecurity,
  deleteTrade,
  setManualPrice,
  updateSecurity,
  updateTrade,
  upsertProviderPrices,
} from "./index";

useTestDB();

describe("investments", () => {
  it("changing or deleting a security and setting a price take the ledger lock", async () => {
    const user = await createTestUser();
    const security = await seedSecurity(user.id);
    const key = `ledger:${user.id}`;
    await expectHeldBy(key, () =>
      setManualPrice(user.id, security.id, {
        date: "2024-01-01",
        price: parseFixed("100"),
      }),
    );
    await expectHeldBy(key, () =>
      updateSecurity(user.id, security.id, {
        name: "Renamed",
        kind: "etf",
        isin: null,
        symbol: null,
        currency: "CHF",
      }),
    );
    await expectHeldBy(key, () => deleteSecurity(user.id, security.id));
  });

  it("adding, changing and deleting a trade take the ledger lock", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id, { type: "investment" });
    const security = await seedSecurity(user.id);
    const key = `ledger:${user.id}`;
    const input = (qty: string) => ({
      securityId: security.id,
      date: "2024-01-15",
      side: "buy" as const,
      quantity: parseFixed(qty),
      price: parseFixed("100"),
      fees: minor(0),
      amount: minor(1000),
      note: null,
      splitNew: null,
      splitOld: null,
    });
    let tradeId = "";
    await expectHeldBy(key, async () => {
      tradeId = (await createTrade(user.id, account.id, input("10"))).id;
    });
    await expectHeldBy(key, () => updateTrade(user.id, tradeId, input("11")));
    await expectHeldBy(key, () => deleteTrade(user.id, tradeId));
  });

  it("storing provider prices takes the ledger lock", async () => {
    const user = await createTestUser();
    const security = await seedSecurity(user.id);
    await expectHeldBy(`ledger:${user.id}`, () =>
      upsertProviderPrices(user.id, security.id, [
        { date: "2024-01-01", price: parseFixed("100") },
      ]),
    );
  });
});
