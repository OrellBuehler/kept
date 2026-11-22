import { afterEach, describe, expect, it } from "vitest";
import { listApiTokens } from "$lib/server/auth/api-tokens";
import { apiTokenConfirmLimiter } from "$lib/server/auth/rate-limit";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount } from "$lib/testing/ledger";
import { actions, load } from "./+page.server";

useTestDB();

afterEach(() => apiTokenConfirmLimiter.reset());

type Form = Record<string, string | string[]>;

function create(user: TestUser, form: Form) {
  const fn = actions.create as (e: never) => unknown;
  return outcome(() =>
    fn(
      createTestEvent({
        user,
        form: { name: "Assistant", adminPassword: user.password, ...form },
        url: "http://kept.test/settings/api-tokens",
      }) as never,
    ),
  );
}

describe("settings/api-tokens: accounts and write permissions", () => {
  it("offers the user's own accounts and the permission groups", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedAccount(a.id, { name: "Mine" });
    await seedAccount(b.id, { name: "Theirs" });
    const r = await outcome(() => load(createTestEvent({ user: a }) as never));
    const data = (
      r as {
        value: {
          accounts: { name: string }[];
          scopeGroups: { title: string; scopes: string[] }[];
          scopeConflicts: Record<string, unknown>;
        };
      }
    ).value;
    expect(data.accounts.map((x) => x.name)).toEqual(["Mine"]);
    expect(data.scopeGroups.map((g) => g.title)).toEqual(["Read", "Write"]);
    expect(data.scopeGroups[1]!.scopes).toContain("bills:write");
    expect(data.scopeConflicts).toHaveProperty("recurring:read");
  });

  it("creates a token with new scopes restricted to chosen accounts", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const r = await create(u, {
      scope: ["transactions:read", "transactions:write", "changes:revert"],
      restrictAccounts: "on",
      accountId: [acc.id],
    });
    expect(r.type).toBe("return");
    const [info] = await listApiTokens(u.id);
    expect(info).toMatchObject({
      accountIds: [acc.id],
      categoryIds: null,
      scopes: [
        "transactions:read",
        "changes:read",
        "transactions:write",
        "changes:revert",
      ],
    });
  });

  it("ignores account ids when the restriction is off, and refuses empty or foreign ones", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const mine = await seedAccount(u.id);
    const theirs = await seedAccount(other.id);
    await create(u, { scope: ["bills:read"], accountId: [mine.id] });
    expect((await listApiTokens(u.id))[0]!.accountIds).toBeNull();
    expect(
      await create(u, { scope: ["bills:read"], restrictAccounts: "on" }),
    ).toMatchObject({
      type: "fail",
      data: { errors: { accountIds: [expect.any(String)] } },
    });
    expect(
      await create(u, {
        scope: ["bills:read"],
        restrictAccounts: "on",
        accountId: [theirs.id],
      }),
    ).toMatchObject({
      type: "fail",
      data: { errors: { accountIds: [expect.any(String)] } },
    });
    expect(await listApiTokens(u.id)).toHaveLength(1);
  });

  it("refuses a permission that cannot honour the restriction and says why", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    const r = await create(u, {
      scope: ["bills:read", "budgets:read"],
      restrictAccounts: "on",
      accountId: [acc.id],
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: {
          scopes: [expect.stringContaining("limited to accounts")],
        },
      },
    });
    expect(await listApiTokens(u.id)).toEqual([]);
  });
});
