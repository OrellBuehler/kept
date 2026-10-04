import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { detectedContributions } from "./contributions";
import { matchReference } from "./reference-match";
import { isContributionPayment, portfolioDepositReferences } from "./transfers";

useTestDB();

const NBSP = String.fromCharCode(0xa0);
const THIN = String.fromCharCode(0x2009);

describe("contribution detection", () => {
  it("strips only space, tab, LF and CR, like the SQL match", () => {
    expect(matchReference(" ab\t1\n2\r3 ")).toBe("AB123");
    expect(matchReference(`12${NBSP}34`)).toBe(`12${NBSP}34`);
  });

  it("agrees with the SQL detection for every reference variant", async () => {
    const user = await createTestUser();
    const threeA = seedPillar3aAccount(user.id);
    const ref = makeQrr(1);
    seedPortfolio(user.id, threeA.id, { depositReference: ref });
    const current = seedAccount(user.id);
    const variants = [
      ref,
      `${ref.slice(0, 2)} ${ref.slice(2)}`,
      `${ref.slice(0, 2)}\t${ref.slice(2)}`,
      `${ref.slice(0, 2)}${NBSP}${ref.slice(2)}`,
      `${ref.slice(0, 2)}${THIN}${ref.slice(2)}`,
    ];
    const txs = variants.map((reference, i) =>
      seedImportedTransaction(user.id, current.id, {
        amount: minor(-1000),
        currency: "CHF",
        bookingDate: `2026-02-0${i + 1}`,
        reference,
      }),
    );
    const detected = new Set(
      detectedContributions(user.id).map((d) => d.transactionId),
    );
    const refs = portfolioDepositReferences(user.id);
    for (const [i, t] of txs.entries()) {
      expect(isContributionPayment(refs, t), variants[i]).toBe(
        detected.has(t.id),
      );
    }
    expect(detected.has(txs[1]!.id)).toBe(true);
    expect(detected.has(txs[3]!.id)).toBe(false);
  });
});
