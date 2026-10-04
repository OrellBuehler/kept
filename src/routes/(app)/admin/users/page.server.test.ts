import { describe, expect, it } from "vitest";
import { totpCode } from "$lib/server/auth/totp";
import {
  confirmTotpEnrolment,
  getTwoFactorStatus,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { listUsers } from "$lib/server/auth/users";
import { authEvents, getDB } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

describe("admin/users", () => {
  useTestDB();

  it("lists users without password hashes", async () => {
    const admin = await createTestUser({ role: "admin" });
    await createTestUser();
    const r = await outcome(() =>
      load(createTestEvent({ user: admin }) as never),
    );
    const users = (r as { value: { users: Record<string, unknown>[] } }).value
      .users;
    expect(users).toHaveLength(2);
    for (const u of users) expect(u).not.toHaveProperty("passwordHash");
  });

  it("creates a member with normalized username", async () => {
    const admin = await createTestUser({ role: "admin" });
    const r = await outcome(() =>
      actions.create(
        createTestEvent({
          user: admin,
          form: {
            username: " Bob ",
            password: "a-long-enough-password",
            role: "member",
            displayName: "",
          },
        }) as never,
      ),
    );
    expect(r).toEqual({
      type: "return",
      value: { created: true, username: "bob" },
    });
    expect(listUsers().find((u) => u.username === "bob")).toMatchObject({
      role: "member",
      displayName: null,
    });
  });

  it("rejects a duplicate username, an invalid role and a short password", async () => {
    const admin = await createTestUser({ role: "admin", username: "boss" });
    const dup = await outcome(() =>
      actions.create(
        createTestEvent({
          user: admin,
          form: {
            username: "BOSS",
            password: "a-long-enough-password",
            role: "member",
          },
        }) as never,
      ),
    );
    expect(dup).toMatchObject({ type: "fail", status: 400 });
    expect(JSON.stringify(dup)).toContain("already taken");

    const bad = await outcome(() =>
      actions.create(
        createTestEvent({
          user: admin,
          form: { username: "carol", password: "short", role: "root" },
        }) as never,
      ),
    );
    expect(bad).toMatchObject({ type: "fail", status: 400 });
    const errors = (bad as { data: { errors: object } }).data.errors;
    expect(Object.keys(errors).sort()).toEqual(["password", "role"]);
  });

  it("deletes another user", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    const r = await outcome(() =>
      actions.delete(
        createTestEvent({ user: admin, form: { userId: member.id } }) as never,
      ),
    );
    expect(r).toEqual({ type: "return", value: { deleted: true } });
    expect(listUsers()).toHaveLength(1);
  });

  it("cannot delete self or the last admin", async () => {
    const admin = await createTestUser({ role: "admin" });
    const r = await outcome(() =>
      actions.delete(
        createTestEvent({ user: admin, form: { userId: admin.id } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
    expect(listUsers()).toHaveLength(1);
  });

  it("rejects a missing userId", async () => {
    const admin = await createTestUser({ role: "admin" });
    const r = await outcome(() =>
      actions.delete(createTestEvent({ user: admin, form: {} }) as never),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });

  it("admin resets a user's two-factor and the event is logged without secrets", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    const { secret } = startTotpEnrolment(member.id, member.username);
    confirmTotpEnrolment(member.id, totpCode(secret, Date.now()));
    const flagged = await outcome(() =>
      load(createTestEvent({ user: admin }) as never),
    );
    const users = (
      flagged as { value: { users: { id: string; twoFactor: boolean }[] } }
    ).value.users;
    expect(users.find((u) => u.id === member.id)?.twoFactor).toBe(true);

    const r = await outcome(() =>
      actions.resetTwoFactor(
        createTestEvent({ user: admin, form: { userId: member.id } }) as never,
      ),
    );
    expect(r).toEqual({ type: "return", value: { twoFactorReset: true } });
    expect(getTwoFactorStatus(member.id).enabled).toBe(false);
    const event = getDB()
      .select()
      .from(authEvents)
      .all()
      .find((e) => e.type === "two_factor_reset");
    expect(event).toMatchObject({ userId: member.id, actorId: admin.id });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("a member cannot reset two-factor", async () => {
    const member = await createTestUser();
    const other = await createTestUser();
    const r = await outcome(() =>
      actions.resetTwoFactor(
        createTestEvent({ user: member, form: { userId: other.id } }) as never,
      ),
    );
    expect(r).toEqual({ type: "error", status: 403 });
  });

  it("reset of an unknown user fails cleanly", async () => {
    const admin = await createTestUser({ role: "admin" });
    const r = await outcome(() =>
      actions.resetTwoFactor(
        createTestEvent({ user: admin, form: { userId: "missing" } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });
});
