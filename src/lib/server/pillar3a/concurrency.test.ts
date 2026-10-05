/**
 * Pillar 3a writes check a rule and then write, so they take the user's
 * ledger lock: two concurrent buy-in saves cannot both pass the yearly cap, and
 * a portfolio cannot be closed or removed between validating a value and
 * writing it. The tests hold the lock from another transaction and expect the
 * operation to wait (meaningful on PostgreSQL; see `expectHeldBy`).
 */
import { describe, it } from "vitest";
import { minor } from "$lib/money";
import { ledgerLock } from "$lib/server/ledger/lock";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import {
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { addManualContribution, deleteContribution } from "./contributions";
import {
  closePortfolio,
  createPortfolio,
  deletePortfolio,
  reopenPortfolio,
  updatePortfolio,
} from "./portfolios";
import { setValues } from "./values";

useTestDB();

async function setup() {
  const user = await createTestUser();
  const account = await seedPillar3aAccount(user.id);
  const portfolio = await seedPortfolio(user.id, account.id, {
    depositReference: makeQrr(1),
  });
  return { user, account, portfolio, key: ledgerLock(user.id) };
}

const contribution = (portfolioId: string) => ({
  portfolioId,
  date: "2027-01-10",
  amount: minor(100_000),
  kind: "ordinary" as const,
  gapYears: [],
  note: null,
});

describe("pillar 3a locks", () => {
  it("contribution saves and deletes", async () => {
    const { user, portfolio, key } = await setup();
    await expectHeldBy(key, () =>
      addManualContribution(user.id, contribution(portfolio.id), "2027-03-01"),
    );
    const saved = await addManualContribution(
      user.id,
      { ...contribution(portfolio.id), date: "2027-01-11" },
      "2027-03-01",
    );
    await expectHeldBy(key, () =>
      deleteContribution(user.id, { id: saved.contribution.id! }, "2027-03-01"),
    );
  });

  it("portfolio writes and value entry", async () => {
    const { user, account, portfolio, key } = await setup();
    const input = {
      name: "Another",
      number: null,
      strategy: null,
      depositReference: null,
      openedOn: null,
      sortOrder: null,
    };
    await expectHeldBy(key, () => createPortfolio(user.id, account.id, input));
    await expectHeldBy(key, () =>
      updatePortfolio(user.id, portfolio.id, {
        ...input,
        depositReference: portfolio.depositReference,
      }),
    );
    await expectHeldBy(key, () =>
      setValues(user.id, account.id, "2026-03-01", [
        { portfolioId: portfolio.id, amount: minor(100) },
      ]),
    );
    await expectHeldBy(key, () =>
      closePortfolio(user.id, portfolio.id, {
        closedOn: "2030-01-01",
        closeReason: "other",
      }),
    );
    await expectHeldBy(key, () => reopenPortfolio(user.id, portfolio.id));
    const empty = await createPortfolio(user.id, account.id, input);
    await expectHeldBy(key, () => deletePortfolio(user.id, empty.id));
  });
});
