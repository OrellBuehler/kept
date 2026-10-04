import { describe, expect, it } from "vitest";
import { totpCode } from "$lib/server/auth/totp";
import {
  confirmTotpEnrolment,
  getTwoFactorStatus,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { listUsers } from "$lib/server/auth/users";
import { adminAuditLog, authEvents, getDB } from "$lib/server/db";
import {
  listAdminAuditLog,
  recordAdminAction,
} from "$lib/server/auth/admin-audit";
import { adminActionLimiter } from "$lib/server/auth/rate-limit";
import { beforeEach } from "vitest";
import {
  addPasskey,
  createTestUser,
  enableTotp,
  loginTestUser,
} from "$lib/testing/auth";
import { markSessionReauthenticated } from "$lib/server/auth/two-factor";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

describe("admin/users", () => {
  useTestDB();
  beforeEach(() => adminActionLimiter.reset());

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
            adminPassword: admin.password,
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
            adminPassword: admin.password,
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
          form: {
            adminPassword: admin.password,
            username: "carol",
            password: "short",
            role: "root",
          },
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
        createTestEvent({
          user: admin,
          form: { userId: member.id, adminPassword: admin.password },
        }) as never,
      ),
    );
    expect(r).toEqual({ type: "return", value: { deleted: true } });
    expect(listUsers()).toHaveLength(1);
  });

  it("cannot delete self or the last admin", async () => {
    const admin = await createTestUser({ role: "admin" });
    const r = await outcome(() =>
      actions.delete(
        createTestEvent({
          user: admin,
          form: { userId: admin.id, adminPassword: admin.password },
        }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
    expect(listUsers()).toHaveLength(1);
  });

  it("rejects a missing userId", async () => {
    const admin = await createTestUser({ role: "admin" });
    const r = await outcome(() =>
      actions.delete(
        createTestEvent({
          user: admin,
          form: { adminPassword: admin.password },
        }) as never,
      ),
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
        createTestEvent({
          user: admin,
          form: { userId: member.id, adminPassword: admin.password },
        }) as never,
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
        createTestEvent({
          user: admin,
          form: { userId: "missing", adminPassword: admin.password },
        }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });

  describe("password confirmation and audit trail", () => {
    const audit = () => getDB().select().from(adminAuditLog).all();

    it("create, delete and reset need the admin's own password", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      const base = { username: "dave", password: "a-long-enough-password" };
      for (const adminPassword of [undefined, "", "wrong-password-here"]) {
        const form = (extra: Record<string, string>) =>
          adminPassword === undefined ? extra : { ...extra, adminPassword };
        const results = await Promise.all([
          outcome(() =>
            actions.create(
              createTestEvent({
                user: admin,
                form: form({ ...base, role: "admin" }),
              }) as never,
            ),
          ),
          outcome(() =>
            actions.delete(
              createTestEvent({
                user: admin,
                form: form({ userId: member.id }),
              }) as never,
            ),
          ),
          outcome(() =>
            actions.resetTwoFactor(
              createTestEvent({
                user: admin,
                form: form({ userId: member.id }),
              }) as never,
            ),
          ),
        ]);
        for (const r of results) {
          expect(r).toMatchObject({ type: "fail", status: 400 });
        }
      }
      expect(listUsers()).toHaveLength(2);
      // only the three real wrong-password attempts are audited, and no action is
      expect(audit().map((r) => r.action)).toEqual([
        "admin_confirm_failed",
        "admin_confirm_failed",
        "admin_confirm_failed",
      ]);
      expect(audit().every((r) => r.details === "reason=password")).toBe(true);
    });

    it("wrong password attempts are rate limited", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      let last: unknown;
      for (let i = 0; i < 6; i++) {
        last = await outcome(() =>
          actions.delete(
            createTestEvent({
              user: admin,
              form: { userId: member.id, adminPassword: "nope-nope-nope" },
            }) as never,
          ),
        );
      }
      expect(last).toMatchObject({ type: "fail", status: 429 });
      expect(listUsers()).toHaveLength(2);
    });

    it("records rate-limit hits once per window instead of once per request", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      for (let i = 0; i < 12; i++) {
        await outcome(() =>
          actions.delete(
            createTestEvent({
              user: admin,
              form: { userId: member.id, adminPassword: "nope-nope-nope" },
            }) as never,
          ),
        );
      }
      const actionsSeen = audit().map((r) => r.action);
      expect(
        actionsSeen.filter((a) => a === "admin_confirm_failed"),
      ).toHaveLength(5);
      expect(
        actionsSeen.filter((a) => a === "admin_confirm_rate_limited"),
      ).toHaveLength(1);
    });

    it("records create, delete and reset without secrets", async () => {
      const admin = await createTestUser({ role: "admin", username: "boss" });
      const member = await createTestUser({ username: "worker" });
      await outcome(() =>
        actions.create(
          createTestEvent({
            user: admin,
            form: {
              adminPassword: admin.password,
              username: "newadmin",
              password: "a-long-enough-password",
              role: "admin",
            },
          }) as never,
        ),
      );
      await outcome(() =>
        actions.resetTwoFactor(
          createTestEvent({
            user: admin,
            form: { adminPassword: admin.password, userId: member.id },
          }) as never,
        ),
      );
      await outcome(() =>
        actions.delete(
          createTestEvent({
            user: admin,
            form: { adminPassword: admin.password, userId: member.id },
          }) as never,
        ),
      );
      const rows = audit();
      expect(rows.map((r) => r.action).sort()).toEqual([
        "user_create",
        "user_delete",
        "user_reset_two_factor",
      ]);
      const created = rows.find((r) => r.action === "user_create")!;
      expect(created).toMatchObject({
        actorUserId: admin.id,
        actorUsername: "boss",
        targetUsername: "newadmin",
        details: "role=admin",
      });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(admin.password);
      expect(text).not.toContain("a-long-enough-password");
      expect(text).not.toContain("passwordHash");
    });

    it("failed actions leave no audit entry", async () => {
      const admin = await createTestUser({ role: "admin" });
      await outcome(() =>
        actions.delete(
          createTestEvent({
            user: admin,
            form: { adminPassword: admin.password, userId: admin.id },
          }) as never,
        ),
      );
      expect(audit()).toHaveLength(0);
    });

    it("load shows the newest entries to admins only", async () => {
      const admin = await createTestUser({ role: "admin" });
      const member = await createTestUser();
      for (let i = 0; i < 25; i++) {
        recordAdminAction(admin, "backup_download");
      }
      const r = (await outcome(() =>
        load(createTestEvent({ user: admin }) as never),
      )) as { value: { audit: { action: string }[] } };
      expect(r.value.audit).toHaveLength(20);
      expect(r.value.audit[0].action).toBe("backup_download");

      expect(
        await outcome(() => load(createTestEvent({ user: member }) as never)),
      ).toEqual({ type: "error", status: 403 });
      expect(() => listAdminAuditLog(member)).toThrow(/Administrator/);
    });
  });
  describe("second factor on the acting administrator", () => {
    const audit = () => getDB().select().from(adminAuditLog).all();
    const create = (
      user: Awaited<ReturnType<typeof createTestUser>>,
      extra: Record<string, string>,
      session?: ReturnType<typeof loginTestUser>["session"],
    ) =>
      outcome(() =>
        actions.create(
          createTestEvent({
            user,
            session,
            form: {
              username: "erin",
              password: "a-long-enough-password",
              role: "member",
              ...extra,
            },
          }) as never,
        ),
      );

    it("with an authenticator app the password alone is not enough", async () => {
      const admin = await createTestUser({ role: "admin" });
      const [recovery] = enableTotp(admin);

      for (const code of [undefined, "", "000000", "bad"]) {
        const r = await create(admin, {
          adminPassword: admin.password,
          ...(code === undefined ? {} : { adminCode: code }),
        });
        expect(r).toMatchObject({ type: "fail", status: 400 });
        expect(JSON.stringify(r)).toContain("adminCode");
      }
      expect(listUsers()).toHaveLength(1);
      expect(audit().every((r) => r.details === "reason=code")).toBe(true);
      expect(audit()).toHaveLength(4);

      const ok = await create(admin, {
        adminPassword: admin.password,
        adminCode: recovery,
      });
      expect(ok).toMatchObject({ type: "return" });
      expect(listUsers()).toHaveLength(2);
    });

    it("a correct code does not replace the password", async () => {
      const admin = await createTestUser({ role: "admin" });
      const [recovery] = enableTotp(admin);
      const r = await create(admin, {
        adminPassword: "wrong-password-here",
        adminCode: recovery,
      });
      expect(r).toMatchObject({ type: "fail", status: 400 });
      expect(listUsers()).toHaveLength(1);
    });

    it("a wrong code counts against the same rate limit", async () => {
      const admin = await createTestUser({ role: "admin" });
      enableTotp(admin);
      let last: unknown;
      for (let i = 0; i < 6; i++) {
        last = await create(admin, {
          adminPassword: admin.password,
          adminCode: "000000",
        });
      }
      expect(last).toMatchObject({ type: "fail", status: 429 });
    });

    it("with only passkeys, a recent passkey step-up of the session is required too", async () => {
      const admin = await createTestUser({ role: "admin" });
      addPasskey(admin.id);
      const { session } = loginTestUser(admin);

      const refused = await create(
        admin,
        { adminPassword: admin.password },
        session,
      );
      expect(refused).toMatchObject({ type: "fail", status: 400 });
      expect(JSON.stringify(refused)).toContain("passkey");
      expect(listUsers()).toHaveLength(1);

      markSessionReauthenticated(admin.id, session.id);
      const wrong = await create(
        admin,
        { adminPassword: "wrong-password-here" },
        session,
      );
      expect(wrong).toMatchObject({ type: "fail", status: 400 });
      const ok = await create(
        admin,
        { adminPassword: admin.password },
        session,
      );
      expect(ok).toMatchObject({ type: "return" });
      expect(listUsers()).toHaveLength(2);
    });

    it("exposes which extra proof the forms must ask for", async () => {
      const plain = await createTestUser({ role: "admin" });
      const withTotp = await createTestUser({ role: "admin" });
      enableTotp(withTotp);
      const withKey = await createTestUser({ role: "admin" });
      addPasskey(withKey.id);
      const mode = async (user: typeof plain) =>
        (
          (await outcome(() => load(createTestEvent({ user }) as never))) as {
            value: { confirmMode: string };
          }
        ).value.confirmMode;
      expect(await mode(plain)).toBe("password");
      expect(await mode(withTotp)).toBe("totp");
      expect(await mode(withKey)).toBe("passkey");
    });
  });
});
