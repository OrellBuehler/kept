import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { API_SCOPES } from "$lib/api-tokens";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { callApi, seedToken } from "$lib/testing/external-api";
import { uploadFixture } from "$lib/testing/imports";
import {
  seedAccount,
  seedImportedTransaction,
  seedInstitution,
} from "$lib/testing/ledger";
import { deleteUser } from "$lib/server/auth/users";
import { changeLog, getDB, recurringSeries, transaction } from "$lib/server/db";
import { confirmImport, undoImport } from "$lib/server/imports";
import {
  archiveAccount,
  deleteAccount,
  unarchiveAccount,
  updateAccount,
} from "$lib/server/ledger/accounts";
import {
  createInstitution,
  deleteInstitution,
  updateInstitution,
} from "$lib/server/ledger/institutions";
import { createSnapshot, deleteSnapshot } from "$lib/server/ledger/snapshots";
import { createCategory } from "$lib/server/categories/categories";
import {
  createBudget,
  deleteBudget,
  updateBudget,
} from "$lib/server/categories/budgets";
import {
  createPlannedItem,
  deletePlannedItem,
  updatePlannedItem,
} from "$lib/server/forecast/planned";
import { saveAccountSettings } from "$lib/server/forecast/settings";
import { updatePreferences } from "$lib/server/preferences";
import { confirmSeries, editSeries } from "$lib/server/recurring/series";
import {
  addTaxCredit,
  deleteTaxCredit,
  deleteTaxYear,
  setTransactionTaxYear,
  upsertTaxYear,
} from "$lib/server/tax/tax";
import {
  setCategoryDeduction,
  setTransactionDeductionYear,
} from "$lib/server/tax/deductions";
import { runAsActor } from "./context";
import { getChange, listChanges, MAX_CHANGE_LIMIT } from "./list";
import { recordChange } from "./record";

useTestDB();

const entry = (userId: string, action: string, entityId?: string) =>
  listChanges(userId, { limit: 200 }).then((p) =>
    p.items.find(
      (e) => e.action === action && (!entityId || e.entityId === entityId),
    ),
  );

describe("recordChange", () => {
  it("refuses to run outside a transaction", async () => {
    const u = await createTestUser();
    await expect(
      recordChange({ userId: u.id, action: "bill.create", entityId: "x" }),
    ).rejects.toThrow(/inside transaction/);
  });

  it("commits with the change and rolls back with it", async () => {
    const u = await createTestUser();
    await transaction(async () => {
      await recordChange({
        userId: u.id,
        action: "bill.create",
        entityId: "kept",
        summary: "Example",
        after: { a: 1 },
      });
    });
    await expect(
      transaction(async () => {
        await recordChange({
          userId: u.id,
          action: "bill.create",
          entityId: "lost",
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    // A savepoint that fails rolls back only its own entries.
    await transaction(async () => {
      await transaction(async () => {
        await recordChange({
          userId: u.id,
          action: "bill.create",
          entityId: "inner-lost",
        });
        throw new Error("inner");
      }).catch(() => undefined);
      await recordChange({
        userId: u.id,
        action: "bill.create",
        entityId: "outer",
      });
    });
    const ids = (await listChanges(u.id)).items.map((e) => e.entityId);
    expect(ids).toEqual(["outer", "kept"]);
  });

  it("stores snapshots as given and null as null", async () => {
    const u = await createTestUser();
    await transaction(async () => {
      await recordChange({
        userId: u.id,
        action: "bill.update",
        entityId: "b",
        before: { amount: 100, tags: ["a", null], nested: { x: true } },
        after: { amount: null },
      });
      await recordChange({
        userId: u.id,
        action: "bill.create",
        entityId: "c",
      });
    });
    const [c, b] = (await listChanges(u.id)).items;
    expect(b).toMatchObject({
      entityType: "bill",
      before: { amount: 100, tags: ["a", null], nested: { x: true } },
      after: { amount: null },
      summary: null,
      revertedAt: null,
      revertedByEntryId: null,
      revertOfEntryId: null,
    });
    expect(c).toMatchObject({ before: null, after: null });
    expect(typeof b!.at).toBe("number");
  });
});

describe("listChanges", () => {
  async function many(userId: string, n: number) {
    await transaction(async () => {
      for (let i = 0; i < n; i++) {
        await recordChange({
          userId,
          action: "bill.create",
          entityId: `e${i}`,
        });
      }
    });
  }

  it("lists newest first in a total order, also for entries made in the same instant", async () => {
    const u = await createTestUser();
    await many(u.id, 12);
    const ids = (await listChanges(u.id)).items.map((e) => e.entityId);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `e${11 - i}`));
  });

  it("pages by cursor without gaps or repeats", async () => {
    const u = await createTestUser();
    await many(u.id, 7);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listChanges(u.id, { limit: 3, before: cursor });
      seen.push(...page.items.map((e) => e.entityId));
      pages++;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(["e6", "e5", "e4", "e3", "e2", "e1", "e0"]);
    expect((await listChanges(u.id, { limit: 7 })).nextCursor).toBeNull();
  });

  it("still pages correctly when more is written between pages", async () => {
    const u = await createTestUser();
    await many(u.id, 4);
    const first = await listChanges(u.id, { limit: 2 });
    await many(u.id, 3);
    const second = await listChanges(u.id, {
      limit: 10,
      before: first.nextCursor!,
    });
    expect(second.items.map((e) => e.entityId)).toEqual(["e1", "e0"]);
  });

  it("filters by actor kind, token, entity type and entity id", async () => {
    const u = await createTestUser();
    await runAsActor(
      { kind: "mcp", userId: u.id, tokenId: "c1", label: "One" },
      () =>
        transaction(async () => {
          await recordChange({
            userId: u.id,
            action: "bill.create",
            entityId: "b1",
          });
          await recordChange({
            userId: u.id,
            action: "category.create",
            entityId: "k1",
          });
        }),
    );
    await runAsActor(
      { kind: "mcp", userId: u.id, tokenId: "c2", label: "Two" },
      () =>
        transaction(async () => {
          await recordChange({
            userId: u.id,
            action: "bill.update",
            entityId: "b1",
          });
        }),
    );
    await runAsActor({ kind: "web", userId: u.id }, () =>
      transaction(async () => {
        await recordChange({
          userId: u.id,
          action: "bill.delete",
          entityId: "b2",
        });
      }),
    );
    const ids = async (f: Parameters<typeof listChanges>[1]) =>
      (await listChanges(u.id, f)).items.map((e) => e.action);
    expect(await ids({ actorKind: "mcp" })).toEqual([
      "bill.update",
      "category.create",
      "bill.create",
    ]);
    expect(await ids({ actorKind: "web" })).toEqual(["bill.delete"]);
    expect(await ids({ tokenId: "c1" })).toEqual([
      "category.create",
      "bill.create",
    ]);
    expect(await ids({ entityType: "bill" })).toEqual([
      "bill.delete",
      "bill.update",
      "bill.create",
    ]);
    expect(await ids({ entityType: "bill", entityId: "b1" })).toEqual([
      "bill.update",
      "bill.create",
    ]);
    expect(
      await ids({ actorKind: "mcp", tokenId: "c2", entityId: "b1" }),
    ).toEqual(["bill.update"]);
    expect(await ids({ actorKind: "api" })).toEqual([]);
  });

  it("only ever returns the user's own entries", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedBill(a.id);
    await seedBill(b.id);
    const mine = (await listChanges(a.id)).items;
    expect(mine).toHaveLength(1);
    const theirs = (await listChanges(b.id)).items;
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.id).not.toBe(mine[0]!.id);
    await expect(getChange(b.id, mine[0]!.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await listChanges(b.id, { entityId: mine[0]!.entityId })).toEqual({
      items: [],
      nextCursor: null,
    });
    // A cursor from another user's log pages nothing of theirs.
    const cursor = `${mine[0]!.seq + 1}:${mine[0]!.id}`;
    const page = await listChanges(a.id, { before: cursor });
    expect(page.items.map((e) => e.id)).toEqual([mine[0]!.id]);
  });

  it("rejects a malformed cursor, filter or limit", async () => {
    const u = await createTestUser();
    for (const bad of [
      { before: "nonsense" },
      { limit: 0 },
      { limit: MAX_CHANGE_LIMIT + 1 },
      { limit: 1.5 },
      { actorKind: "robot" as never },
    ]) {
      await expect(listChanges(u.id, bad)).rejects.toMatchObject({
        code: "invalid",
      });
    }
  });
});

describe("through the external API", () => {
  it("a link written through the external API is logged as that token", async () => {
    const user = await createTestUser();
    const bill = await seedBill(user.id);
    const { token, info } = await seedToken(user.id, API_SCOPES, {
      name: "Hauswart",
    });
    const res = await callApi(
      token,
      `/api/external/v1/bills/${bill.id}/links`,
      {
        method: "POST",
        body: {
          source: "hauswart",
          label: "Costs",
          url: "https://home.example.org/costs/1",
        },
      },
    );
    expect(res.status).toBe(201);
    const entry = (await listChanges(user.id, { entityType: "external_link" }))
      .items[0]!;
    expect(entry.action).toBe("external_link.create");
    expect(entry.actor).toEqual({
      kind: "api",
      tokenId: info.id,
      label: "Hauswart",
    });
  });
});

describe("deleting a user", () => {
  it("deletes their change log and nobody else's", async () => {
    const admin = await createTestUser({ role: "admin" });
    const other = await createTestUser({ role: "admin" });
    const target = await createTestUser();
    await seedBill(target.id);
    await seedBill(other.id);
    await deleteUser(admin.id, target.id);
    expect(
      await getDB()
        .select()
        .from(changeLog)
        .where(eq(changeLog.userId, target.id)),
    ).toEqual([]);
    expect((await listChanges(other.id)).items).toHaveLength(1);
  });
});

describe("what the log keeps of everyday changes", () => {
  async function world() {
    const u = await createTestUser();
    const institution = await seedInstitution(u.id, "Example Bank");
    const account = await seedAccount(u.id, {
      iban: EXAMPLE_IBAN,
      institutionId: institution.id,
    });
    return { u, institution, account };
  }

  it("records accounts, institutions and balances", async () => {
    const { u, account } = await world();
    expect((await entry(u.id, "institution.create"))?.after).toMatchObject({
      name: "Example Bank",
    });
    expect(await entry(u.id, "account.create", account.id)).toMatchObject({
      summary: "Main",
      after: { name: "Main", currency: "CHF", iban: EXAMPLE_IBAN },
    });

    await updateAccount(u.id, account.id, {
      institutionId: account.institution?.id ?? null,
      name: "Renamed",
      type: "current",
      currency: "CHF",
      iban: EXAMPLE_IBAN,
      contractNumber: null,
      depositIban: null,
      openingBalance: minor(0),
      openingDate: null,
      noticeMonths: null,
      freeWithdrawal: null,
      freeWithdrawalPeriod: null,
      shareBps: 10000,
      sharedWith: null,
      sortOrder: null,
      fillFromTransfers: false,
      tradesMoveCash: false,
    });
    expect(await entry(u.id, "account.update")).toMatchObject({
      before: { name: "Main" },
      after: { name: "Renamed" },
    });

    await archiveAccount(u.id, account.id);
    expect(await entry(u.id, "account.archive")).toMatchObject({
      before: { archived: false },
      after: { archived: true },
    });
    await unarchiveAccount(u.id, account.id);
    expect(await entry(u.id, "account.unarchive")).toBeDefined();

    const snap = await createSnapshot(u.id, account.id, {
      date: "2026-01-31",
      amount: minor(1234),
      note: null,
    });
    expect(await entry(u.id, "snapshot.create", snap.id)).toMatchObject({
      after: { date: "2026-01-31", amount: 1234 },
    });
    await deleteSnapshot(u.id, snap.id);
    expect(await entry(u.id, "snapshot.delete", snap.id)).toMatchObject({
      before: { amount: 1234 },
    });

    const spare = await createInstitution(u.id, {
      name: "Spare",
      bic: null,
      color: null,
    });
    await updateInstitution(u.id, spare.id, {
      name: "Spare 2",
      bic: null,
      color: "#112233",
    });
    expect(await entry(u.id, "institution.update", spare.id)).toMatchObject({
      before: { name: "Spare", color: null },
      after: { name: "Spare 2", color: "#112233" },
    });
    await deleteInstitution(u.id, spare.id);
    expect(await entry(u.id, "institution.delete", spare.id)).toBeDefined();

    await seedImportedTransaction(u.id, account.id);
    await deleteAccount(u.id, account.id);
    expect(await entry(u.id, "account.delete", account.id)).toMatchObject({
      before: { name: "Renamed", transactionCount: 1 },
    });
  });

  it("records budgets, planned items, forecast settings and preferences", async () => {
    const { u, account } = await world();
    const food = await createCategory(u.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    const budget = await createBudget(u.id, {
      categoryId: food.id,
      currency: "CHF",
      amount: minor(1000),
    });
    await updateBudget(u.id, budget.id, {
      categoryId: food.id,
      currency: "CHF",
      amount: minor(2000),
    });
    expect(await entry(u.id, "budget.update", budget.id)).toMatchObject({
      before: { amount: 1000 },
      after: { amount: 2000 },
    });
    await deleteBudget(u.id, budget.id);
    expect(await entry(u.id, "budget.delete", budget.id)).toMatchObject({
      before: { amount: 2000 },
    });
    expect(await entry(u.id, "budget.create", budget.id)).toBeDefined();

    const item = await createPlannedItem(u.id, {
      label: "Roof repair",
      date: "2026-12-01",
      direction: "expense",
      amount: "50.00",
      accountId: account.id,
      currency: null,
    });
    expect(await entry(u.id, "planned_item.create", item.id)).toMatchObject({
      summary: "Roof repair",
      after: { amount: -5000, date: "2026-12-01" },
    });
    await updatePlannedItem(u.id, item.id, {
      label: "Roof repair",
      date: "2026-12-15",
      direction: "expense",
      amount: "50.00",
      accountId: account.id,
      currency: null,
    });
    expect(await entry(u.id, "planned_item.update", item.id)).toMatchObject({
      before: { date: "2026-12-01" },
      after: { date: "2026-12-15" },
    });
    await deletePlannedItem(u.id, item.id);
    expect(await entry(u.id, "planned_item.delete", item.id)).toBeDefined();

    await saveAccountSettings(u.id, {
      accountId: account.id,
      threshold: "100.00",
      defaultPayment: "on",
    });
    expect(await entry(u.id, "forecast_setting.update")).toMatchObject({
      before: { threshold: null, defaultPayment: false },
      after: { threshold: 10000, defaultPayment: true },
    });

    await updatePreferences(u.id, { pageSize: 25 });
    const pref = await entry(u.id, "preference.update");
    expect(pref?.after).toMatchObject({ pageSize: 25 });
    expect(Object.keys(pref!.after!)).toEqual(["pageSize"]);
    const n = (await listChanges(u.id, { limit: 200 })).items.length;
    await updatePreferences(u.id, { pageSize: 25 });
    expect((await listChanges(u.id, { limit: 200 })).items).toHaveLength(n);
  });

  it("records recurring payment edits and tax changes", async () => {
    const { u, account } = await world();
    const [series] = await getDB()
      .insert(recurringSeries)
      .values({
        userId: u.id,
        key: "k",
        name: "Rent",
        cadence: "monthly",
        currency: "CHF",
        amount: minor(-100000),
        firstDate: "2026-01-01",
        lastDate: "2026-06-01",
        lastAmount: minor(-100000),
        occurrences: 6,
      })
      .returning();
    await confirmSeries(u.id, series!.id);
    expect(await entry(u.id, "recurring_series.update")).toMatchObject({
      before: { status: "suggested" },
      after: { status: "confirmed" },
    });
    await editSeries(u.id, series!.id, {
      name: "Flat rent",
      cadence: "monthly",
      amount: "1100.00",
    });
    expect(
      (await listChanges(u.id, { entityId: series!.id })).items[0],
    ).toMatchObject({
      summary: "Flat rent",
      before: { name: "Rent", amount: -100000 },
      after: { name: "Flat rent", amount: -110000 },
    });

    const year = await upsertTaxYear(u.id, {
      year: 2025,
      authority: null,
      currency: "CHF",
      assessedTotal: minor(5000),
      notes: null,
    });
    expect(await entry(u.id, "tax_year.create", year.id!)).toMatchObject({
      summary: "Tax year 2025",
      after: { year: 2025, assessedTotal: 5000 },
    });
    await upsertTaxYear(u.id, {
      year: 2025,
      authority: null,
      currency: "CHF",
      assessedTotal: minor(6000),
      notes: null,
    });
    expect(await entry(u.id, "tax_year.update", year.id!)).toMatchObject({
      before: { assessedTotal: 5000 },
      after: { assessedTotal: 6000 },
    });
    const credit = await addTaxCredit(u.id, 2025, {
      bookingDate: "2025-06-01",
      amount: minor(3000),
      reference: null,
      description: null,
    });
    expect(await entry(u.id, "tax_credit.create", credit.id)).toMatchObject({
      after: { year: 2025, amount: 3000 },
    });
    await deleteTaxCredit(u.id, credit.id);
    expect(await entry(u.id, "tax_credit.delete", credit.id)).toBeDefined();

    const tx = await seedImportedTransaction(u.id, account.id, {
      counterpartyName: "Tax Office",
    });
    await setTransactionTaxYear(u.id, tx.id, 2025);
    await setTransactionDeductionYear(u.id, tx.id, 2024);
    const taxed = await listChanges(u.id, { entityId: tx.id });
    expect(taxed.items.map((e) => [e.before, e.after])).toEqual([
      [{ deductionYear: null }, { deductionYear: 2024 }],
      [{ taxYear: null }, { taxYear: 2025 }],
    ]);

    const food = await createCategory(u.id, {
      name: "Donations",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await setCategoryDeduction(u.id, food.id, "donations");
    expect(await entry(u.id, "deduction_mapping.update")).toMatchObject({
      before: { deductionType: null },
      after: { deductionType: "donations" },
    });

    await deleteTaxYear(u.id, 2025);
    expect(await entry(u.id, "tax_year.delete", year.id!)).toMatchObject({
      before: { year: 2025, statementLines: 0 },
    });
  });

  it("records one entry per import and per undo, not one per transaction", async () => {
    const { u, account } = await world();
    const before = (await listChanges(u.id, { limit: 200 })).items.length;
    const result = await confirmImport(
      u.id,
      await uploadFixture(u.id, account.id, "camt053/overlap-a.xml"),
    );
    expect(result.newCount).toBeGreaterThan(1);
    const after = (await listChanges(u.id, { limit: 200 })).items;
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({
      action: "import.confirm",
      entityId: result.importId,
      after: { accountId: account.id, newCount: result.newCount },
    });
    await undoImport(u.id, result.importId);
    expect(await entry(u.id, "import.undo", result.importId)).toMatchObject({
      before: { removedTransactions: result.newCount },
    });
    expect((await listChanges(u.id, { limit: 200 })).items.length).toBe(
      before + 2,
    );
  });

  it("keeps secrets and tokens out of every snapshot", async () => {
    const { u } = await world();
    const rows = await getDB()
      .select({ before: changeLog.before, after: changeLog.after })
      .from(changeLog);
    const text = JSON.stringify(rows).toLowerCase();
    for (const word of ["password", "secret", "totp", "token", "hash"]) {
      expect(text).not.toContain(word);
    }
    expect(u.id).toBeTruthy();
  });
});
