/**
 * Trades and manual prices rely on their security (its currency, that it exists)
 * and check it in their own transactions, so changing the security takes the
 * same per-user lock.
 */
import { describe, it } from "vitest";
import { parseFixed } from "$lib/quantity";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedSecurity } from "$lib/testing/investments";
import { expectHeldBy } from "$lib/testing/locks";
import { deleteSecurity, setManualPrice, updateSecurity } from "./index";

useTestDB();

describe("investments", () => {
  it("changing or deleting a security and setting a manual price take the trades lock", async () => {
    const user = await createTestUser();
    const security = await seedSecurity(user.id);
    const key = `trades:${user.id}`;
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
});
