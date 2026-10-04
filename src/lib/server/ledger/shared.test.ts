import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { parseForm } from "$lib/server/forms";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import {
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "./accounts";
import { LedgerError } from "./errors";
import { accountInputSchema } from "./schemas";

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

const valid = { name: "Joint", type: "current", currency: "CHF" };

describe("account form: my share", () => {
  it("defaults to 100% and no co-owner note", () => {
    const r = parseForm(accountInputSchema, form(valid));
    expect(r).toMatchObject({
      ok: true,
      data: { shareBps: 10000, sharedWith: null },
    });
    if (r.ok) expect("share" in r.data).toBe(false);
    expect(
      parseForm(accountInputSchema, form({ ...valid, share: "  " })),
    ).toMatchObject({ ok: true, data: { shareBps: 10000 } });
  });

  it.each([
    ["50", 5000],
    ["70", 7000],
    ["33.33", 3333],
    ["33,33", 3333],
    ["100", 10000],
    ["0.01", 1],
    ["12.5 %", 1250],
  ])("accepts %j as %i basis points", (share, bps) => {
    expect(
      parseForm(accountInputSchema, form({ ...valid, share })),
    ).toMatchObject({ ok: true, data: { shareBps: bps } });
  });

  it.each(["0", "0.00", "-10", "100.01", "101", "abc", "33.333", "1e1"])(
    "rejects %j",
    (share) => {
      const r = parseForm(accountInputSchema, form({ ...valid, share }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.share).toBeDefined();
    },
  );

  it("trims the note, treats blank as none and limits its length", () => {
    expect(
      parseForm(
        accountInputSchema,
        form({ ...valid, sharedWith: "  Partner  " }),
      ),
    ).toMatchObject({ ok: true, data: { sharedWith: "Partner" } });
    expect(
      parseForm(accountInputSchema, form({ ...valid, sharedWith: " " })),
    ).toMatchObject({ ok: true, data: { sharedWith: null } });
    const long = parseForm(
      accountInputSchema,
      form({ ...valid, sharedWith: "x".repeat(81) }),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.sharedWith).toBeDefined();
  });

  it("reports share and balance errors together with other fields", () => {
    const r = parseForm(
      accountInputSchema,
      form({ ...valid, share: "0", openingBalance: "1.234" }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("shared accounts in the ledger", () => {
  useTestDB();

  it("creates, updates and lists the share", async () => {
    const u = await createTestUser();
    const parsed = parseForm(
      accountInputSchema,
      form({ ...valid, share: "33.33", sharedWith: "Partner" }),
    );
    if (!parsed.ok) throw new Error("form must parse");
    const created = createAccount(u.id, parsed.data);
    expect(created).toMatchObject({ shareBps: 3333, sharedWith: "Partner" });

    const updated = updateAccount(u.id, created.id, {
      ...parsed.data,
      shareBps: 5000,
      sharedWith: null,
    });
    expect(updated).toMatchObject({ shareBps: 5000, sharedWith: null });
    expect(listAccounts(u.id)[0]).toMatchObject({ shareBps: 5000 });
  });

  it("never scales stored transactions or the full balance", async () => {
    const u = await createTestUser();
    const a = seedAccount(u.id, {
      openingBalance: minor(1001),
      shareBps: 5000,
    });
    const tx = seedImportedTransaction(u.id, a.id, {
      amount: minor(-501),
      bookingDate: "2026-01-02",
    });
    expect(tx.amount).toBe(-501);
    const view = getAccount(u.id, a.id, "2026-02-01");
    expect(view.balance).toBe(500);
    expect(view.shareBalance).toBe(250);
    updateAccount(u.id, a.id, {
      name: view.name,
      type: view.type,
      currency: view.currency,
      iban: null,
      contractNumber: null,
      depositIban: null,
      institutionId: null,
      openingBalance: view.openingBalance,
      openingDate: null,
      noticeMonths: null,
      freeWithdrawal: null,
      freeWithdrawalPeriod: null,
      fillFromTransfers: false,
      tradesMoveCash: false,
      shareBps: 2500,
      sharedWith: null,
      sortOrder: null,
    });
    expect(getAccount(u.id, a.id, "2026-02-01").balance).toBe(500);
  });

  it("keeps accounts scoped to their owner", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const a = seedAccount(owner.id, { shareBps: 5000, sharedWith: "Partner" });
    expect(listAccounts(other.id)).toEqual([]);
    expect(() => getAccount(other.id, a.id)).toThrow(LedgerError);
    expect(() =>
      updateAccount(other.id, a.id, {
        name: "Mine now",
        type: "current",
        currency: "CHF",
        iban: null,
        contractNumber: null,
        depositIban: null,
        institutionId: null,
        openingBalance: minor(0),
        openingDate: null,
        noticeMonths: null,
        freeWithdrawal: null,
        freeWithdrawalPeriod: null,
        fillFromTransfers: false,
        tradesMoveCash: false,
        shareBps: 10000,
        sharedWith: null,
        sortOrder: null,
      }),
    ).toThrow(LedgerError);
    expect(getAccount(owner.id, a.id)).toMatchObject({
      name: "Main",
      shareBps: 5000,
    });
  });
});
