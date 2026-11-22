import { describe, expect, it } from "vitest";
import { apiTokens } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount } from "$lib/testing/ledger";
import {
  createApiToken,
  createApiTokenSchema,
  listApiTokens,
  verifyApiToken,
} from "./api-tokens";

const base = {
  name: "x",
  scopes: ["bills:read"],
  categoryIds: null,
  expiresAt: null,
};

const input = (over: Partial<Parameters<typeof createApiToken>[1]> = {}) => ({
  name: "Companion",
  scopes: ["bills:read" as const],
  categoryIds: null,
  expiresAt: null,
  ...over,
});

describe("api tokens: account restriction", () => {
  const ctx = useTestDB();

  it("stores the user's own accounts and reports them", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id);
    const { token, info } = await createApiToken(
      u.id,
      input({ accountIds: [a.id, a.id] }),
    );
    expect(info.accountIds).toEqual([a.id]);
    expect((await listApiTokens(u.id))[0]!.accountIds).toEqual([a.id]);
    expect(await verifyApiToken(token)).toMatchObject({
      ok: true,
      token: { accountIds: [a.id], categoryIds: null },
    });
    const [row] = await ctx.db.select().from(apiTokens);
    expect(row!.accountIds).toEqual([a.id]);
  });

  it("defaults to all accounts, and refuses an empty or foreign list", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id);
    const { info } = await createApiToken(u.id, input());
    expect(info.accountIds).toBeNull();
    await expect(
      createApiToken(u.id, input({ accountIds: [theirs.id] })),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      createApiToken(u.id, input({ accountIds: ["nope"] })),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(
      createApiTokenSchema.safeParse({ ...base, accountIds: [] }).success,
    ).toBe(false);
    expect(
      createApiTokenSchema.safeParse({ ...base, accountIds: ["a"] }).success,
    ).toBe(true);
    expect(
      createApiTokenSchema.safeParse({ ...base, accountIds: null }).success,
    ).toBe(true);
  });
});

describe("api tokens: scope and restriction combinations", () => {
  const refused = (over: object) => {
    const r = createApiTokenSchema.safeParse({ ...base, ...over });
    return r.success ? null : r.error.issues.map((i) => i.message);
  };

  it("refuses a scope that cannot honour a restriction, and says why", () => {
    expect(refused({ scopes: ["recurring:read"], accountIds: ["a"] })).toEqual([
      "A token limited to accounts cannot read recurring payments: they are detected across all accounts.",
    ]);
    expect(refused({ scopes: ["recurring:read"], categoryIds: ["c"] })).toEqual(
      [
        "A token limited to categories cannot read recurring payments: they are detected across all categories.",
      ],
    );
    for (const scope of [
      "budgets:read",
      "forecast:read",
      "pillar3a:read",
      "taxes:read",
      "categories:write",
    ]) {
      expect(
        refused({ scopes: [scope], accountIds: ["a"] }),
        scope,
      ).not.toBeNull();
      expect(
        refused({ scopes: [scope], categoryIds: ["c"] }),
        scope,
      ).not.toBeNull();
    }
    expect(
      refused({ scopes: ["balances:read"], categoryIds: ["c"] }),
    ).not.toBeNull();
    expect(
      refused({ scopes: ["investments:read"], categoryIds: ["c"] }),
    ).not.toBeNull();
  });

  it("accepts the scopes that do honour them", () => {
    for (const scope of [
      "bills:read",
      "bills:write",
      "transactions:read",
      "transactions:write",
      "matches:write",
      "accounts:read",
      "categories:read",
      "changes:read",
      "changes:revert",
      "links:write",
    ]) {
      expect(
        refused({ scopes: [scope], accountIds: ["a"], categoryIds: ["c"] }),
        scope,
      ).toBeNull();
    }
    expect(
      refused({ scopes: ["balances:read"], accountIds: ["a"] }),
    ).toBeNull();
    expect(
      refused({ scopes: ["investments:read"], accountIds: ["a"] }),
    ).toBeNull();
  });

  it("lets changes:revert bring changes:read along", () => {
    const parsed = createApiTokenSchema.parse({
      ...base,
      scopes: ["changes:revert"],
    });
    expect(parsed.scopes).toEqual(["changes:read", "changes:revert"]);
  });
});
