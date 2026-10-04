import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLimiter } from "$lib/server/auth/rate-limit";
import { hashPassword } from "$lib/server/auth/password";
import {
  SESSION_COOKIE,
  validateSessionToken,
} from "$lib/server/auth/sessions";
import { countUsers, listUsers } from "$lib/server/auth/users";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { FakeCookies, createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

vi.mock("$lib/server/auth/password", async (orig) => {
  const mod = await orig<typeof import("$lib/server/auth/password")>();
  return { ...mod, hashPassword: vi.fn(mod.hashPassword) };
});

const goodForm = {
  username: "  Owner ",
  password: "a-long-enough-password",
  displayName: "The Owner",
};

describe("setup", () => {
  useTestDB();
  beforeEach(() => {
    setupLimiter.reset();
    vi.mocked(hashPassword).mockClear();
  });

  it("load returns an empty object on a fresh database", async () => {
    expect(await outcome(() => load(createTestEvent() as never))).toEqual({
      type: "return",
      value: {},
    });
  });

  it("load redirects to /login when a user exists", async () => {
    await createTestUser();
    expect(await outcome(() => load(createTestEvent() as never))).toMatchObject(
      {
        type: "redirect",
        location: "/login",
      },
    );
  });

  it("creates the first user as admin, logs in and redirects home", async () => {
    const event = createTestEvent({ form: goodForm });
    const result = await outcome(() => actions.default(event as never));
    expect(result).toMatchObject({
      type: "redirect",
      status: 303,
      location: "/",
    });
    const [user] = listUsers();
    expect(user).toMatchObject({
      username: "owner",
      role: "admin",
      displayName: "The Owner",
    });
    const token = (event.cookies as unknown as FakeCookies).get(
      SESSION_COOKIE,
    )!;
    expect(validateSessionToken(token)?.user.id).toBe(user.id);
  });

  it("returns field errors and never echoes the password", async () => {
    const result = await outcome(() =>
      actions.default(
        createTestEvent({
          form: { username: "x", password: "short" },
        }) as never,
      ),
    );
    expect(result).toMatchObject({ type: "fail", status: 400 });
    const data = (result as { data: Record<string, unknown> }).data;
    expect(Object.keys(data.errors as object).sort()).toEqual([
      "password",
      "username",
    ]);
    expect(data.values).toEqual({ username: "x", displayName: "" });
    expect(JSON.stringify(data)).not.toContain("short");
    expect(countUsers()).toBe(0);
  });

  it("a second setup attempt does not create another user", async () => {
    await outcome(() =>
      actions.default(createTestEvent({ form: goodForm }) as never),
    );
    const second = await outcome(() =>
      actions.default(
        createTestEvent({
          form: { username: "intruder", password: "a-long-enough-password" },
        }) as never,
      ),
    );
    expect(second).toMatchObject({ type: "redirect", location: "/login" });
    expect(listUsers().map((u) => u.username)).toEqual(["owner"]);
  });

  it("concurrent setup attempts create exactly one admin", async () => {
    const attempt = (name: string) =>
      outcome(() =>
        actions.default(
          createTestEvent({
            form: { username: name, password: "a-long-enough-password" },
          }) as never,
        ),
      );
    const results = await Promise.all([attempt("first"), attempt("second")]);
    expect(
      results.map((r) => (r as { location: string }).location).sort(),
    ).toEqual(["/", "/login"]);
    expect(countUsers()).toBe(1);
  });

  it("does not hash a password once setup is done", async () => {
    await createTestUser();
    vi.mocked(hashPassword).mockClear();
    const result = await outcome(() =>
      actions.default(createTestEvent({ form: goodForm }) as never),
    );
    expect(result).toMatchObject({ type: "redirect", location: "/login" });
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("concurrent attempts hash only once", async () => {
    const attempt = (name: string) =>
      outcome(() =>
        actions.default(
          createTestEvent({
            form: { username: name, password: "a-long-enough-password" },
          }) as never,
        ),
      );
    await Promise.all([attempt("first"), attempt("second"), attempt("third")]);
    expect(hashPassword).toHaveBeenCalledTimes(1);
    expect(countUsers()).toBe(1);
  });

  it("rate limits submissions per ip, not globally", async () => {
    const bad = (ip: string) =>
      outcome(() =>
        actions.default(
          createTestEvent({
            ip,
            form: { username: "owner", password: "a-long-enough-password" },
          }) as never,
        ),
      );
    for (let i = 0; i < 20; i++) setupLimiter.acquire("setup", "198.51.100.1");
    const blocked = await bad("198.51.100.1");
    expect(blocked).toMatchObject({ type: "fail", status: 429 });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(countUsers()).toBe(0);
    const other = await bad("198.51.100.2");
    expect(other).toMatchObject({ type: "redirect", location: "/" });
  });
});
