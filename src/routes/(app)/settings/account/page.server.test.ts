import { describe, expect, it } from "vitest";
import { verifyPassword } from "$lib/server/auth/password";
import { validateSessionToken } from "$lib/server/auth/sessions";
import { findUserByUsername } from "$lib/server/auth/users";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

describe("settings/account", () => {
  useTestDB();

  it("load returns the current user only", async () => {
    const a = await createTestUser();
    await createTestUser();
    const r = await outcome(() => load(createTestEvent({ user: a }) as never));
    expect(r).toEqual({
      type: "return",
      value: {
        user: {
          id: a.id,
          username: a.username,
          displayName: null,
          role: "member",
        },
      },
    });
  });

  it("changes the password, keeps this session, drops the others", async () => {
    const a = await createTestUser();
    const here = loginTestUser(a);
    const elsewhere = loginTestUser(a);
    const event = createTestEvent({
      user: a,
      session: here.session,
      form: { currentPassword: a.password, newPassword: "brand-new-password" },
    });
    expect(await outcome(() => actions.changePassword(event as never))).toEqual(
      {
        type: "return",
        value: { success: true },
      },
    );
    expect(validateSessionToken(here.token)).not.toBeNull();
    expect(validateSessionToken(elsewhere.token)).toBeNull();
    const row = findUserByUsername(a.username)!;
    expect(await verifyPassword("brand-new-password", row.passwordHash)).toBe(
      true,
    );
  });

  it("rejects a wrong current password", async () => {
    const a = await createTestUser();
    const r = await outcome(() =>
      actions.changePassword(
        createTestEvent({
          user: a,
          form: {
            currentPassword: "wrong-password-xx",
            newPassword: "brand-new-password",
          },
        }) as never,
      ),
    );
    expect(r).toEqual({
      type: "fail",
      status: 400,
      data: { errors: { currentPassword: ["Current password is incorrect."] } },
    });
  });

  it("validates the new password length", async () => {
    const a = await createTestUser();
    const r = await outcome(() =>
      actions.changePassword(
        createTestEvent({
          user: a,
          form: { currentPassword: a.password, newPassword: "short" },
        }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
    expect(JSON.stringify(r)).not.toContain(a.password);
  });

  it("only ever changes the caller's own password (no userId is accepted)", async () => {
    const a = await createTestUser();
    const b = await createTestUser({ password: "bobs-own-password" });
    const r = await outcome(() =>
      actions.changePassword(
        createTestEvent({
          user: a,
          form: {
            userId: b.id,
            currentPassword: b.password,
            newPassword: "brand-new-password",
          },
        }) as never,
      ),
    );
    // a's current password is not b's password, so nothing changes for anyone
    expect(r).toMatchObject({ type: "fail", status: 400 });
    const rowB = findUserByUsername(b.username)!;
    expect(await verifyPassword(b.password, rowB.passwordHash)).toBe(true);
    const rowA = findUserByUsername(a.username)!;
    expect(await verifyPassword(a.password, rowA.passwordHash)).toBe(true);
  });
});
