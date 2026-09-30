import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { uploadFixture, usePendingDir } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { getDB, transactions } from "$lib/server/db";
import { confirmImport, listImports } from "$lib/server/imports";
import { actions, load } from "./+page.server";

useTestDB();
usePendingDir();

type User = Awaited<ReturnType<typeof createTestUser>>;

const loadAs = (user: User, accountId: string) =>
  outcome(() =>
    load(createTestEvent({ user, params: { id: accountId } }) as never),
  );
const undo = (user: User, accountId: string, form: Record<string, string>) =>
  outcome(() =>
    actions.undo!(
      createTestEvent({ user, params: { id: accountId }, form }) as never,
    ),
  );

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
  const imp = confirmImport(
    user.id,
    uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
  );
  return { user, account, imp };
}

describe("/accounts/[id]/imports", () => {
  it("load returns the account and its imports, newest first", async () => {
    const { user, account, imp } = await setup();
    const second = confirmImport(
      user.id,
      uploadFixture(user.id, account.id, "camt053/overlap-b.xml"),
    );
    const r = await loadAs(user, account.id);
    const v = (
      r as { value: { account: { id: string }; imports: { id: string }[] } }
    ).value;
    expect(v.account.id).toBe(account.id);
    expect(v.imports.map((i) => i.id)).toEqual([second.importId, imp.importId]);
  });

  it("undo removes the import and its transactions", async () => {
    const { user, account, imp } = await setup();
    const r = await undo(user, account.id, { importId: imp.importId });
    expect(r).toEqual({
      type: "return",
      value: {
        success: true,
        action: "undo",
        id: imp.importId,
        removedTransactions: 5,
      },
    });
    expect(listImports(user.id, account.id)).toEqual([]);
    expect(getDB().select().from(transactions).all()).toEqual([]);
  });

  it("undo fails with 400 without an import id, 404 for unknown ones", async () => {
    const { user, account } = await setup();
    expect(await undo(user, account.id, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
    expect(await undo(user, account.id, { importId: "nope" })).toEqual({
      type: "error",
      status: 404,
    });
  });

  it("undo is bound to the account in the URL", async () => {
    const { user, imp } = await setup();
    const otherAccount = seedAccount(user.id, { name: "Other", iban: null });
    expect(
      await undo(user, otherAccount.id, { importId: imp.importId }),
    ).toEqual({
      type: "error",
      status: 404,
    });
    expect(getDB().select().from(transactions).all()).toHaveLength(5);
  });

  it("another user cannot list or undo my imports", async () => {
    const { account, imp } = await setup();
    const other = await createTestUser();
    expect(await loadAs(other, account.id)).toEqual({
      type: "error",
      status: 404,
    });
    expect(await undo(other, account.id, { importId: imp.importId })).toEqual({
      type: "error",
      status: 404,
    });
    const theirs = seedAccount(other.id, { iban: null });
    expect(await undo(other, theirs.id, { importId: imp.importId })).toEqual({
      type: "error",
      status: 404,
    });
    expect(getDB().select().from(transactions).all()).toHaveLength(5);
  });
});
