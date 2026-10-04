import { describe, expect, it } from "vitest";
import { users } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { verifyPassword } from "./password";
import { createSession, validateSessionToken } from "./sessions";
import { AuthError } from "./types";
import {
  changePassword,
  countUsers,
  createFirstAdmin,
  createUser,
  deleteUser,
  listUsers,
} from "./users";

async function codeOf(p: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof AuthError) return err.code;
    throw err;
  }
  return null;
}

describe("users", () => {
  const ctx = useTestDB();

  it("counts users", async () => {
    expect(countUsers()).toBe(0);
    await createTestUser();
    expect(countUsers()).toBe(1);
  });

  it("normalizes usernames and hashes passwords with argon2id", async () => {
    const u = await createUser({
      username: "  MiXed.Case ",
      password: "a-long-enough-password",
      role: "member",
    });
    expect(u.username).toBe("mixed.case");
    const row = ctx.db.select().from(users).get();
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain("a-long-enough-password");
  });

  it("rejects duplicate usernames, case-insensitively", async () => {
    await createTestUser({ username: "alice" });
    expect(
      await codeOf(
        createUser({
          username: "ALICE",
          password: "another-long-password",
          role: "member",
        }),
      ),
    ).toBe("username_taken");
  });

  it("defaults role to member in the database", async () => {
    const u = await createTestUser();
    expect(u.role).toBe("member");
  });

  it("setup race: only one of two concurrent first-admin attempts succeeds", async () => {
    const attempt = (name: string) =>
      createFirstAdmin({ username: name, password: "a-long-enough-password" });
    const results = await Promise.allSettled([attempt("one"), attempt("two")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "setup_closed",
    });
    expect(countUsers()).toBe(1);
    expect(listUsers()[0].role).toBe("admin");
  });

  it("first-admin setup fails once a user exists", async () => {
    await createTestUser();
    expect(
      await codeOf(
        createFirstAdmin({
          username: "late",
          password: "a-long-enough-password",
        }),
      ),
    ).toBe("setup_closed");
  });

  it("listUsers never exposes password hashes", async () => {
    await createTestUser();
    const list = listUsers();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual([
      "createdAt",
      "displayName",
      "id",
      "role",
      "username",
    ]);
  });

  describe("changePassword", () => {
    it("changes the password and drops other sessions but keeps the current one", async () => {
      const u = await createTestUser();
      const keep = createSession(u.id);
      const other = createSession(u.id);
      await changePassword(
        u.id,
        u.password,
        "brand-new-password",
        keep.session.id,
      );
      const row = ctx.db.select().from(users).get()!;
      expect(await verifyPassword("brand-new-password", row.passwordHash)).toBe(
        true,
      );
      expect(validateSessionToken(keep.token)).not.toBeNull();
      expect(validateSessionToken(other.token)).toBeNull();
    });

    it("rejects a wrong current password and changes nothing", async () => {
      const u = await createTestUser();
      const s = createSession(u.id);
      expect(
        await codeOf(
          changePassword(u.id, "wrong-password-xx", "brand-new-password"),
        ),
      ).toBe("invalid_credentials");
      expect(validateSessionToken(s.token)).not.toBeNull();
      const row = ctx.db.select().from(users).get()!;
      expect(await verifyPassword(u.password, row.passwordHash)).toBe(true);
    });

    it("rate limits wrong current-password guesses per user", async () => {
      const u = await createTestUser();
      const other = await createTestUser();
      for (let i = 0; i < 5; i++) {
        expect(
          await codeOf(
            changePassword(u.id, "wrong-password-xx", "brand-new-password"),
          ),
        ).toBe("invalid_credentials");
      }
      await expect(
        changePassword(u.id, u.password, "brand-new-password"),
      ).rejects.toThrow(/too many attempts/i);
      await changePassword(other.id, other.password, "brand-new-password");
    });

    it("bumps updatedAt", async () => {
      const u = await createTestUser();
      const before = ctx.db.select().from(users).get()!.updatedAt.getTime();
      await new Promise((r) => setTimeout(r, 5));
      await changePassword(u.id, u.password, "brand-new-password");
      const after = ctx.db.select().from(users).get()!.updatedAt.getTime();
      expect(after).toBeGreaterThan(before);
    });
  });

  describe("deleteUser", () => {
    it("deletes another user", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      deleteUser(admin.id, member.id);
      expect(listUsers().map((u) => u.id)).toEqual([admin.id]);
    });

    it("refuses to delete yourself", async () => {
      const admin = await createTestUser({ role: "admin" });
      await createTestUser({ role: "admin" });
      expect(await codeOf(() => deleteUser(admin.id, admin.id))).toBe(
        "cannot_delete_self",
      );
    });

    it("refuses to delete the last admin", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      // actor is a different user (e.g. a stale admin session)
      expect(await codeOf(() => deleteUser(member.id, admin.id))).toBe(
        "cannot_delete_last_admin",
      );
      expect(countUsers()).toBe(2);
    });

    it("allows deleting an admin when another exists", async () => {
      const a = await createTestUser({ role: "admin" });
      const b = await createTestUser({ role: "admin" });
      deleteUser(a.id, b.id);
      expect(listUsers().map((u) => u.id)).toEqual([a.id]);
    });

    it("reports unknown users", async () => {
      const admin = await createTestUser({ role: "admin" });
      expect(await codeOf(() => deleteUser(admin.id, "missing"))).toBe(
        "user_not_found",
      );
    });

    it("invalidates the deleted user's sessions", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      const s = createSession(member.id);
      deleteUser(admin.id, member.id);
      expect(validateSessionToken(s.token)).toBeNull();
    });
  });

  describe("audit in the same transaction", () => {
    const boom = () => {
      throw new Error("audit failed");
    };

    it("createUser rolls the user back when the audit write fails", async () => {
      await expect(
        createUser(
          {
            username: "newbie",
            password: "a-long-enough-password",
            role: "member",
          },
          boom,
        ),
      ).rejects.toThrow("audit failed");
      expect(listUsers()).toHaveLength(0);
    });

    it("deleteUser keeps the user when the audit write fails", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      expect(() => deleteUser(admin.id, member.id, boom)).toThrow(
        "audit failed",
      );
      expect(listUsers()).toHaveLength(2);
      const seen: string[] = [];
      deleteUser(admin.id, member.id, (_tx, t) => seen.push(t.username));
      expect(seen).toEqual([member.username]);
    });
  });
});
