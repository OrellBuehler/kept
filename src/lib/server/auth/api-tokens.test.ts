import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { API_SCOPES } from "$lib/api-tokens";
import { apiTokens, authEvents } from "$lib/server/db";
import { createCategory } from "$lib/server/categories";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  LAST_USED_THROTTLE_MS,
  MAX_ACTIVE_TOKENS,
  MAX_TOKEN_LIFETIME_MS,
  createApiToken,
  createApiTokenSchema,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "./api-tokens";
import { hashToken } from "./sessions";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const input = (over: Partial<Parameters<typeof createApiToken>[1]> = {}) => ({
  name: "Companion",
  scopes: ["bills:read" as const],
  categoryIds: null,
  expiresAt: null,
  ...over,
});

describe("api tokens", () => {
  const ctx = useTestDB();

  it("creates a kept_ token and stores only its hash", async () => {
    const u = await createTestUser();
    const { token, info } = await createApiToken(u.id, input(), T0);
    expect(token).toMatch(/^kept_[A-Za-z0-9_-]{43}$/);
    const rows = await ctx.db.select().from(apiTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]!.prefix).toBe(token.slice(0, 11));
    expect(info).toMatchObject({
      name: "Companion",
      scopes: ["bills:read"],
      categoryIds: null,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(info)).not.toContain(token);
  });

  it("generates different tokens every time", async () => {
    const u = await createTestUser();
    const a = await createApiToken(u.id, input());
    const b = await createApiToken(u.id, input());
    expect(a.token).not.toBe(b.token);
  });

  it("verifies a valid token and returns its owner, scopes and categories", async () => {
    const u = await createTestUser();
    const cat = await createCategory(u.id, {
      name: "Housing",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    const { token } = await createApiToken(
      u.id,
      input({ scopes: ["bills:read", "links:write"], categoryIds: [cat.id] }),
    );
    const result = await verifyApiToken(token);
    expect(result).toMatchObject({
      ok: true,
      token: {
        userId: u.id,
        scopes: ["bills:read", "links:write"],
        categoryIds: [cat.id],
      },
    });
  });

  it("refuses unknown, malformed and foreign-prefix tokens", async () => {
    const u = await createTestUser();
    await createApiToken(u.id, input());
    for (const bad of [
      "",
      "kept_",
      "kept_nope",
      "nope",
      `kept_${"a".repeat(500)}`,
    ]) {
      expect(await verifyApiToken(bad), bad).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("refuses a revoked token", async () => {
    const u = await createTestUser();
    const { token, info } = await createApiToken(u.id, input());
    await revokeApiToken(u.id, info.id);
    expect(await verifyApiToken(token)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("refuses an expired token, at the expiry instant already", async () => {
    const u = await createTestUser();
    const { token } = await createApiToken(
      u.id,
      input({ expiresAt: new Date(T0 + DAY) }),
      T0,
    );
    expect((await verifyApiToken(token, T0 + DAY - 1)).ok).toBe(true);
    expect(await verifyApiToken(token, T0 + DAY)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects an expiry in the past or beyond five years", async () => {
    const u = await createTestUser();
    await expect(
      createApiToken(u.id, input({ expiresAt: new Date(T0 - 1) }), T0),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      createApiToken(
        u.id,
        input({ expiresAt: new Date(T0 + MAX_TOKEN_LIFETIME_MS + 1) }),
        T0,
      ),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(await listApiTokens(u.id)).toEqual([]);
  });

  it("refreshes lastUsedAt at most once per throttle window", async () => {
    const u = await createTestUser();
    const { token, info } = await createApiToken(u.id, input());
    const lastUsed = async () =>
      (
        await ctx.db
          .select({ at: apiTokens.lastUsedAt })
          .from(apiTokens)
          .where(eq(apiTokens.id, info.id))
      )[0]!.at?.getTime() ?? null;

    expect(await lastUsed()).toBeNull();
    await verifyApiToken(token, T0);
    expect(await lastUsed()).toBe(T0);
    await verifyApiToken(token, T0 + LAST_USED_THROTTLE_MS - 1);
    expect(await lastUsed()).toBe(T0);
    await verifyApiToken(token, T0 + LAST_USED_THROTTLE_MS + 1);
    expect(await lastUsed()).toBe(T0 + LAST_USED_THROTTLE_MS + 1);
  });

  it("does not touch lastUsedAt for refused tokens", async () => {
    const u = await createTestUser();
    const { token, info } = await createApiToken(u.id, input());
    await revokeApiToken(u.id, info.id);
    await verifyApiToken(token, T0);
    expect((await listApiTokens(u.id))[0]!.lastUsedAt).toBeNull();
  });

  it("lists only the user's own tokens, newest first, without secrets", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const first = await createApiToken(a.id, input({ name: "first" }));
    const second = await createApiToken(a.id, input({ name: "second" }));
    await createApiToken(b.id, input({ name: "theirs" }));
    const list = await listApiTokens(a.id);
    expect(list.map((t) => t.name).sort()).toEqual(["first", "second"]);
    expect(list.map((t) => t.id).sort()).toEqual(
      [first.info.id, second.info.id].sort(),
    );
    expect(JSON.stringify(list)).not.toContain(first.token);
    expect(Object.keys(list[0]!)).not.toContain("tokenHash");
  });

  it("revokes idempotently and never another user's token", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = await createApiToken(a.id, input());
    await expect(revokeApiToken(b.id, mine.info.id)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await verifyApiToken(mine.token)).ok).toBe(true);

    await revokeApiToken(a.id, mine.info.id, T0);
    await revokeApiToken(a.id, mine.info.id, T0 + 5000);
    const [row] = await listApiTokens(a.id);
    expect(row!.revokedAt).toBe(T0);
  });

  it("requires categories of the token's own user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const theirs = await createCategory(b.id, {
      name: "Theirs",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    await expect(
      createApiToken(a.id, input({ categoryIds: [theirs.id] })),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      createApiToken(a.id, input({ categoryIds: ["nope"] })),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await listApiTokens(a.id)).toEqual([]);
  });

  it("caps the number of active tokens, and a revoked one frees a slot", async () => {
    const u = await createTestUser();
    const made = [];
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      made.push(await createApiToken(u.id, input({ name: `t${i}` })));
    }
    await expect(createApiToken(u.id, input())).rejects.toMatchObject({
      code: "invalid",
    });
    await revokeApiToken(u.id, made[0]!.info.id);
    await expect(createApiToken(u.id, input())).resolves.toBeDefined();
  });

  it("records create and revoke in the audit trail without secrets", async () => {
    const u = await createTestUser();
    const { token, info } = await createApiToken(u.id, input());
    await revokeApiToken(u.id, info.id);
    const events = await ctx.db.select().from(authEvents);
    expect(events.map((e) => e.type).sort()).toEqual([
      "api_token_created",
      "api_token_revoked",
    ]);
    expect(events.every((e) => e.userId === u.id && e.actorId === u.id)).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("is removed with its user", async () => {
    const u = await createTestUser();
    const { token } = await createApiToken(u.id, input());
    const { users } = await import("$lib/server/db");
    await ctx.db.delete(users).where(eq(users.id, u.id));
    expect(await verifyApiToken(token)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("createApiTokenSchema", () => {
  it("trims the name, orders scopes and de-duplicates categories", () => {
    const parsed = createApiTokenSchema.parse({
      name: "  Reader ",
      scopes: ["links:write", "bills:read"],
      categoryIds: ["a", "b", "a"],
      expiresAt: null,
    });
    expect(parsed.name).toBe("Reader");
    expect(parsed.scopes).toEqual(["bills:read", "links:write"]);
    expect(parsed.categoryIds).toEqual(["a", "b"]);
  });

  it("never reads an empty category list as no restriction", () => {
    const base = {
      name: "x",
      scopes: ["bills:read"],
      expiresAt: null,
    };
    expect(
      createApiTokenSchema.safeParse({ ...base, categoryIds: [] }).success,
    ).toBe(false);
    expect(
      createApiTokenSchema.parse({ ...base, categoryIds: null }).categoryIds,
    ).toBeNull();
  });

  it("refuses recurring payments for a category-restricted token", () => {
    const base = { name: "x", expiresAt: null };
    expect(
      createApiTokenSchema.safeParse({
        ...base,
        scopes: ["bills:read", "recurring:read"],
        categoryIds: ["a"],
      }).success,
    ).toBe(false);
    expect(
      createApiTokenSchema.safeParse({
        ...base,
        scopes: ["recurring:read"],
        categoryIds: null,
      }).success,
    ).toBe(true);
  });

  it("rejects empty names, no scopes and unknown scopes", () => {
    const base = {
      name: "x",
      scopes: ["bills:read"],
      categoryIds: null,
      expiresAt: null,
    };
    expect(createApiTokenSchema.safeParse({ ...base, name: " " }).success).toBe(
      false,
    );
    expect(
      createApiTokenSchema.safeParse({ ...base, scopes: [] }).success,
    ).toBe(false);
    expect(
      createApiTokenSchema.safeParse({ ...base, scopes: ["admin"] }).success,
    ).toBe(false);
    expect(
      createApiTokenSchema.safeParse({ ...base, name: "x".repeat(65) }).success,
    ).toBe(false);
  });

  it("knows every scope the API documents", () => {
    expect([...API_SCOPES]).toEqual([
      "bills:read",
      "transactions:read",
      "recurring:read",
      "categories:read",
      "accounts:read",
      "links:write",
    ]);
  });
});
