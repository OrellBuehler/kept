import { afterEach, describe, expect, it } from "vitest";
import { listApiTokens, verifyApiToken } from "$lib/server/auth/api-tokens";
import { apiTokenConfirmLimiter } from "$lib/server/auth/rate-limit";
import { createCategory } from "$lib/server/categories";
import { apiTokens, getDB } from "$lib/server/db";
import { createTestUser, enableTotp, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

useTestDB();

afterEach(() => apiTokenConfirmLimiter.reset());

type Form = Record<string, string | string[]>;

function act(name: keyof typeof actions, user: TestUser | null, form: Form) {
  const fn = actions[name] as (e: never) => unknown;
  return outcome(() =>
    fn(
      createTestEvent({
        user,
        form,
        url: "http://kept.test/settings/api-tokens",
      }) as never,
    ),
  );
}

const valid = (user: TestUser, over: Form = {}): Form => ({
  name: "Home app",
  scope: ["bills:read", "links:write"],
  adminPassword: user.password,
  ...over,
});

async function category(userId: string, name: string) {
  return createCategory(userId, {
    name,
    kind: "expense",
    parentId: null,
    color: null,
    icon: null,
  });
}

describe("settings/api-tokens load", () => {
  it("lists only the user's tokens, never the hash, and offers the user's categories", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await category(a.id, "Mine");
    await category(b.id, "Theirs");
    await act("create", a, valid(a, { name: "mine" }));
    await act("create", b, valid(b, { name: "theirs" }));
    const r = await outcome(() => load(createTestEvent({ user: a }) as never));
    expect(r.type).toBe("return");
    const data = (
      r as {
        value: {
          tokens: { name: string }[];
          categories: { name: string }[];
          confirmMode: string;
        };
      }
    ).value;
    expect(data.tokens.map((t) => t.name)).toEqual(["mine"]);
    expect(JSON.stringify(data)).not.toMatch(
      /tokenHash|kept_[A-Za-z0-9_-]{43}/,
    );
    expect(data.categories.map((c) => c.name)).toEqual(["Mine"]);
    expect(data.confirmMode).toBe("password");
  });
});

describe("settings/api-tokens create", () => {
  it("creates a token, returns the plaintext once and stores only its hash", async () => {
    const u = await createTestUser();
    const r = await act("create", u, valid(u));
    expect(r.type).toBe("return");
    const value = (
      r as { value: { created: true; token: string; name: string } }
    ).value;
    expect(value).toMatchObject({ created: true, name: "Home app" });
    expect(value.token).toMatch(/^kept_[A-Za-z0-9_-]{43}$/);

    const [info] = await listApiTokens(u.id);
    expect(info).toMatchObject({
      name: "Home app",
      scopes: ["bills:read", "links:write"],
      categoryIds: null,
      expiresAt: null,
    });
    expect(
      JSON.stringify(await getDB().select().from(apiTokens)),
    ).not.toContain(value.token);
    expect((await verifyApiToken(value.token)).ok).toBe(true);

    const loaded = await outcome(() =>
      load(createTestEvent({ user: u }) as never),
    );
    expect(JSON.stringify(loaded)).not.toContain(value.token);
  });

  it("restricts to chosen categories and sets an expiry at the end of the day (UTC)", async () => {
    const u = await createTestUser();
    const cat = await category(u.id, "Housing");
    const year = new Date().getUTCFullYear() + 1;
    const r = await act(
      "create",
      u,
      valid(u, {
        restrict: "on",
        categoryId: [cat.id],
        expires: `${year}-06-30`,
      }),
    );
    expect(r.type).toBe("return");
    const [info] = await listApiTokens(u.id);
    expect(info!.categoryIds).toEqual([cat.id]);
    expect(info!.expiresAt).toBe(Date.UTC(year, 5, 30, 23, 59, 59, 999));
  });

  it("does not create a token with the wrong password", async () => {
    const u = await createTestUser();
    const r = await act(
      "create",
      u,
      valid(u, { adminPassword: "wrong-password-1" }),
    );
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { adminPassword: [expect.any(String)] } },
    });
    expect(await listApiTokens(u.id)).toEqual([]);
  });

  it("does not create a token without a password", async () => {
    const u = await createTestUser();
    const form = valid(u);
    delete form.adminPassword;
    const r = await act("create", u, form);
    expect(r).toMatchObject({ type: "fail", status: 400 });
    expect(await listApiTokens(u.id)).toEqual([]);
  });

  it("answers repeated wrong passwords with 429", async () => {
    const u = await createTestUser();
    let last;
    for (let i = 0; i < 8; i++) {
      last = await act(
        "create",
        u,
        valid(u, { adminPassword: "wrong-password-1" }),
      );
    }
    expect(last).toMatchObject({ type: "fail", status: 429 });
    // even the right password waits
    expect(await act("create", u, valid(u))).toMatchObject({ status: 429 });
    expect(await listApiTokens(u.id)).toEqual([]);
  });

  it("asks for an authenticator code when two-factor is on", async () => {
    const u = await createTestUser();
    const [recovery] = await enableTotp(u);
    const without = await act("create", u, valid(u));
    expect(without).toMatchObject({ type: "fail", status: 400 });
    expect(await listApiTokens(u.id)).toEqual([]);
    const wrong = await act("create", u, valid(u, { adminCode: "000000" }));
    expect(wrong).toMatchObject({
      type: "fail",
      data: { errors: { adminCode: [expect.any(String)] } },
    });
    const ok = await act("create", u, valid(u, { adminCode: recovery! }));
    expect(ok.type).toBe("return");
    expect(await listApiTokens(u.id)).toHaveLength(1);
  });

  it("validates name, permissions, categories and expiry", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const theirs = await category(other.id, "Theirs");
    const cases: [Form, string][] = [
      [valid(u, { name: " " }), "name"],
      [valid(u, { name: "x".repeat(65) }), "name"],
      [valid(u, { scope: [] }), "scopes"],
      [valid(u, { scope: ["admin:all"] }), "scopes"],
      [valid(u, { restrict: "on" }), "categoryIds"],
      [valid(u, { restrict: "on", categoryId: [theirs.id] }), "categoryIds"],
      [valid(u, { expires: "2001-01-01" }), "expires"],
      [valid(u, { expires: "tomorrow" }), "expires"],
      [valid(u, { expires: "2999-01-01" }), "expires"],
    ];
    for (const [form, field] of cases) {
      const r = await act("create", u, form);
      expect(r, JSON.stringify(form)).toMatchObject({
        type: "fail",
        status: 400,
        data: { errors: { [field]: [expect.any(String)] } },
      });
    }
    expect(await listApiTokens(u.id)).toEqual([]);
  });

  it("ignores category ids when the restriction is off", async () => {
    const u = await createTestUser();
    const cat = await category(u.id, "Housing");
    await act("create", u, valid(u, { categoryId: [cat.id] }));
    expect((await listApiTokens(u.id))[0]!.categoryIds).toBeNull();
  });

  it("rejects anonymous callers", async () => {
    const u = await createTestUser();
    expect(await act("create", null, valid(u))).toEqual({
      type: "error",
      status: 401,
    });
  });
});

describe("settings/api-tokens revoke", () => {
  async function made(user: TestUser) {
    const r = await act("create", user, valid(user));
    const token = (r as { value: { token: string } }).value.token;
    const [info] = await listApiTokens(user.id);
    return { token, id: info!.id };
  }

  it("revokes the user's own token", async () => {
    const u = await createTestUser();
    const { token, id } = await made(u);
    const r = await act("revoke", u, { tokenId: id });
    expect(r).toMatchObject({ type: "return", value: { revoked: true } });
    expect(await verifyApiToken(token)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("cannot revoke another user's token", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { token, id } = await made(a);
    expect(await act("revoke", b, { tokenId: id })).toEqual({
      type: "error",
      status: 404,
    });
    expect((await verifyApiToken(token)).ok).toBe(true);
  });

  it("rejects an unknown token id and a missing one", async () => {
    const u = await createTestUser();
    expect(await act("revoke", u, { tokenId: "nope" })).toEqual({
      type: "error",
      status: 404,
    });
    expect(await act("revoke", u, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
  });
});
