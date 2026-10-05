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
  errorCode,
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

function scor(body: string): string {
  const digits = [...`${body}RF00`]
    .map((c) => (c >= "A" ? String(c.charCodeAt(0) - 55) : c))
    .join("");
  const check = 98 - Number(BigInt(digits) % 97n);
  return `RF${String(check).padStart(2, "0")}${body}`;
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
    const acc = await seedPillar3aAccount(u.id);
    expect(await getAccount(u.id, acc.id)).toMatchObject({
      type: "pillar_3a",
      contractNumber: "TEST-0001",
      depositIban: QR_IBAN,
      iban: null,
      shareBps: 10000,
    });
    expect((await listAccounts(u.id))[0]).toMatchObject({
      depositIban: QR_IBAN,
    });
    expect((await accountBalances(u.id, "2026-01-01"))[0]).toMatchObject({
      contractNumber: "TEST-0001",
      depositIban: QR_IBAN,
    });
  });

  it("allows the same deposit IBAN on several accounts (providers share it)", async () => {
    const u = await createTestUser();
    await seedPillar3aAccount(u.id, { name: "A" });
    await expect(
      seedPillar3aAccount(u.id, { name: "B" }),
    ).resolves.not.toThrow();
  });

  it("blocks a currency change once portfolio values exist", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id, { iban: EXAMPLE_IBAN });
    const p = await seedPortfolio(u.id, acc.id, {
      depositReference: makeQrr(1),
    });
    await setValues(u.id, acc.id, "2026-01-01", [
      { portfolioId: p.id, amount: minor(100) },
    ]);
    const input = {
      institutionId: null,
      name: acc.name,
      type: "pillar_3a" as const,
      currency: "EUR",
      iban: acc.iban,
      contractNumber: null,
      depositIban: null,
      openingBalance: acc.openingBalance,
      openingDate: null,
      noticeMonths: null,
      freeWithdrawal: null,
      freeWithdrawalPeriod: null,
      fillFromTransfers: false,
      tradesMoveCash: false,
      shareBps: 10000,
      sharedWith: null,
      sortOrder: null,
    };
    await expect(updateAccount(u.id, acc.id, input)).rejects.toThrow(
      LedgerError,
    );
    await expect(
      updateAccount(u.id, acc.id, { ...input, currency: "CHF" }),
    ).resolves.not.toThrow();
  });

  describe("keeps portfolios consistent", () => {
    const inputOf = (
      acc: Awaited<ReturnType<typeof seedPillar3aAccount>>,
      over = {},
    ) => ({
      institutionId: null,
      name: acc.name,
      type: "pillar_3a" as const,
      currency: "CHF",
      iban: null,
      contractNumber: "TEST-0001",
      depositIban: QR_IBAN as string | null,
      openingBalance: acc.openingBalance,
      openingDate: null,
      noticeMonths: null,
      freeWithdrawal: null,
      freeWithdrawalPeriod: null,
      fillFromTransfers: false,
      tradesMoveCash: false,
      shareBps: 10000,
      sharedWith: null,
      sortOrder: null,
      ...over,
    });

    it("rejects a type change while portfolios exist", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      await seedPortfolio(u.id, acc.id);
      expect(
        await errorCode(() =>
          updateAccount(
            u.id,
            acc.id,
            inputOf(acc, { type: "savings", contractNumber: null }),
          ),
        ),
      ).toBe("conflict:type");
      expect((await getAccount(u.id, acc.id)).type).toBe("pillar_3a");

      const empty = await seedPillar3aAccount(u.id, { name: "Empty" });
      await expect(
        updateAccount(
          u.id,
          empty.id,
          inputOf(empty, { type: "savings", contractNumber: null }),
        ),
      ).resolves.not.toThrow();
    });

    it("revalidates references when the deposit IBAN changes", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      await seedPortfolio(u.id, acc.id, { depositReference: makeQrr(1) });
      expect(
        await errorCode(() =>
          updateAccount(
            u.id,
            acc.id,
            inputOf(acc, { depositIban: EXAMPLE_IBAN }),
          ),
        ),
      ).toBe("invalid:depositIban");
      expect((await getAccount(u.id, acc.id)).depositIban).toBe(QR_IBAN);
      await expect(
        updateAccount(u.id, acc.id, inputOf(acc, { depositIban: null })),
      ).resolves.not.toThrow();
    });

    it("rejects a creditor reference behind a QR-IBAN", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id, {
        depositIban: EXAMPLE_IBAN,
      });
      await seedPortfolio(u.id, acc.id, { depositReference: scor("12345") });
      expect(
        await errorCode(() =>
          updateAccount(u.id, acc.id, inputOf(acc, { depositIban: QR_IBAN })),
        ),
      ).toBe("invalid:depositIban");
    });

    it("blocks a currency change while portfolios exist, even without values", async () => {
      const u = await createTestUser();
      const acc = await seedPillar3aAccount(u.id);
      await seedPortfolio(u.id, acc.id);
      expect(
        await errorCode(() =>
          updateAccount(u.id, acc.id, inputOf(acc, { currency: "EUR" })),
        ),
      ).toBe("conflict:currency");
    });
  });
});
