import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { parseForm } from "$lib/server/forms";
import {
  accountInputSchema,
  getAccount,
  LedgerError,
  listAccounts,
  updateAccount,
} from "$lib/server/ledger";
import { accountBalances } from "$lib/server/dashboard/accounts";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import {
  makeQrr,
  QR_IBAN,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { setValues } from "./values";

useTestDB();

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

const base = { name: "Retirement", type: "pillar_3a", currency: "CHF" };

describe("pillar_3a account input", () => {
  it("accepts a contract number and a deposit IBAN, normalized", () => {
    const r = parseForm(
      accountInputSchema,
      form({
        ...base,
        contractNumber: " TEST-0001 ",
        depositIban: "ch44 3199 9123 0008 8901 2",
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      data: { contractNumber: "TEST-0001", depositIban: QR_IBAN },
    });
  });

  it("rejects an invalid deposit IBAN", () => {
    const r = parseForm(
      accountInputSchema,
      form({ ...base, depositIban: QR_IBAN.slice(0, -1) + "0" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.depositIban).toBeDefined();
  });

  it("requires CHF", () => {
    const r = parseForm(accountInputSchema, form({ ...base, currency: "EUR" }));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.currency).toEqual([
        "A pillar 3a account must be in CHF.",
      ]);
  });

  it("forces the share to 100% and drops the shared-with note", () => {
    const r = parseForm(
      accountInputSchema,
      form({ ...base, share: "50", sharedWith: "Someone" }),
    );
    expect(r).toMatchObject({
      ok: true,
      data: { shareBps: 10000, sharedWith: null },
    });
    const invalidShare = parseForm(
      accountInputSchema,
      form({ ...base, share: "abc" }),
    );
    expect(invalidShare.ok).toBe(true);
  });

  it("ignores both fields on other account types", () => {
    const r = parseForm(
      accountInputSchema,
      form({
        name: "Main",
        type: "current",
        currency: "EUR",
        contractNumber: "TEST-0001",
        depositIban: QR_IBAN,
        share: "50",
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      data: { contractNumber: null, depositIban: null, shareBps: 5000 },
    });
  });
});

describe("pillar_3a account service", () => {
  it("returns both fields in views and dashboard balances", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    expect(getAccount(u.id, acc.id)).toMatchObject({
      type: "pillar_3a",
      contractNumber: "TEST-0001",
      depositIban: QR_IBAN,
      iban: null,
      shareBps: 10000,
    });
    expect(listAccounts(u.id)[0]).toMatchObject({ depositIban: QR_IBAN });
    expect(accountBalances(u.id, "2026-01-01")[0]).toMatchObject({
      contractNumber: "TEST-0001",
      depositIban: QR_IBAN,
    });
  });

  it("allows the same deposit IBAN on several accounts (providers share it)", async () => {
    const u = await createTestUser();
    seedPillar3aAccount(u.id, { name: "A" });
    expect(() => seedPillar3aAccount(u.id, { name: "B" })).not.toThrow();
  });

  it("blocks a currency change once portfolio values exist", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id, { iban: EXAMPLE_IBAN });
    const p = seedPortfolio(u.id, acc.id, {
      depositReference: makeQrr(1),
    });
    setValues(u.id, acc.id, "2026-01-01", [
      { portfolioId: p.id, amount: minor(100) },
    ]);
    const input = {
      institutionId: null,
      name: acc.name,
      type: "current" as const,
      currency: "EUR",
      iban: acc.iban,
      contractNumber: null,
      depositIban: null,
      openingBalance: acc.openingBalance,
      openingDate: null,
      shareBps: 10000,
      sharedWith: null,
      sortOrder: null,
    };
    expect(() => updateAccount(u.id, acc.id, input)).toThrow(LedgerError);
    expect(() =>
      updateAccount(u.id, acc.id, { ...input, currency: "CHF" }),
    ).not.toThrow();
  });
});
