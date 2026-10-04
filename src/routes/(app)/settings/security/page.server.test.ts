import { beforeEach, describe, expect, it } from "vitest";
import { twoFactorManageLimiter } from "$lib/server/auth/rate-limit";
import { totpCode } from "$lib/server/auth/totp";
import {
  confirmTotpEnrolment,
  getTwoFactorStatus,
  hasRecentReauth,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { eq } from "drizzle-orm";
import { validateSessionToken } from "$lib/server/auth/sessions";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { REAUTH_WINDOW_MS } from "$lib/server/auth/two-factor";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { getDB, passkeys, sessions } from "$lib/server/db";
import { actions, load } from "./+page.server";

async function sess(
  u: Awaited<ReturnType<typeof createTestUser>>,
  reauthAgeMs: number | null = 0,
) {
  const s = await loginTestUser(u);
  if (reauthAgeMs !== null) {
    await getDB()
      .update(sessions)
      .set({ reauthAt: new Date(Date.now() - reauthAgeMs) })
      .where(eq(sessions.id, s.session.id));
  }
  return { user: u, session: s.session };
}

async function seedPasskey(userId: string, credentialId = "cred") {
  await getDB().insert(passkeys).values({
    userId,
    name: "Laptop",
    credentialId,
    publicKey: "AQID",
    deviceType: "singleDevice",
    backedUp: false,
  });
  return (await getDB().select().from(passkeys)).find(
    (p) => p.credentialId === credentialId,
  )!;
}

describe("settings/security", () => {
  useTestDB();
  beforeEach(() => twoFactorManageLimiter.reset());

  it("load shows enrolment secret only while pending and never leaks key material", async () => {
    const u = await createTestUser();
    await seedPasskey(u.id);
    const r = (await outcome(() =>
      load(createTestEvent({ user: u }) as never),
    )) as {
      value: {
        enrolment: unknown;
        passkeys: Record<string, unknown>[];
        status: unknown;
      };
    };
    expect(r.value.enrolment).toBeNull();
    expect(r.value.passkeys).toHaveLength(1);
    expect(JSON.stringify(r.value.passkeys)).not.toContain("AQID");
    expect(r.value.passkeys[0]).not.toHaveProperty("publicKey");

    await outcome(() =>
      actions.startTotp(
        createTestEvent({ user: u, form: { password: u.password } }) as never,
      ),
    );
    const after = (await outcome(() =>
      load(createTestEvent({ user: u }) as never),
    )) as {
      value: { enrolment: { secret: string; qr: string } };
    };
    expect(after.value.enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(after.value.enrolment.qr).toMatch(/^data:image\/png;base64,/);
  });

  it("enrols with a valid code and returns recovery codes once", async () => {
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const bad = await outcome(() =>
      actions.confirmTotp(
        createTestEvent({
          user: u,
          form: { code: "000000", password: u.password },
        }) as never,
      ),
    );
    expect(bad).toMatchObject({ type: "fail", status: 400 });
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(false);
    const ok = await outcome(() =>
      actions.confirmTotp(
        createTestEvent({
          user: u,
          form: { code: totpCode(secret, Date.now()), password: u.password },
        }) as never,
      ),
    );
    expect(ok).toMatchObject({ type: "return" });
    expect(
      (ok as { value: { recoveryCodes: string[] } }).value.recoveryCodes,
    ).toHaveLength(10);
    const after = (await outcome(() =>
      load(createTestEvent({ user: u }) as never),
    )) as {
      value: { status: { totpEnabled: boolean }; enrolment: unknown };
    };
    expect(after.value.status.totpEnabled).toBe(true);
    expect(after.value.enrolment).toBeNull();
  });

  it("disabling needs the right password and a valid code", async () => {
    const u = await createTestUser();
    const past = Date.now() - 600_000;
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const codes = await confirmTotpEnrolment(
      u.id,
      totpCode(secret, past),
      past,
    );
    const wrongPw = await outcome(() =>
      actions.disableTotp(
        createTestEvent({
          user: u,
          form: { password: "nope-nope-nope", code: codes[0] },
        }) as never,
      ),
    );
    expect(wrongPw).toMatchObject({ type: "fail", status: 400 });
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(true);
    const ok = await outcome(() =>
      actions.disableTotp(
        createTestEvent({
          user: u,
          form: { password: u.password, code: codes[1] },
        }) as never,
      ),
    );
    expect(ok).toMatchObject({ type: "return", value: { disabled: true } });
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(false);
  });

  it("starting enrolment is refused while TOTP is enabled", async () => {
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    await confirmTotpEnrolment(u.id, totpCode(secret, Date.now()));
    const r = await outcome(() =>
      actions.startTotp(
        createTestEvent({ user: u, form: { password: u.password } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });

  it("starting enrolment needs the current password", async () => {
    const u = await createTestUser();
    for (const form of [
      {} as Record<string, string>,
      { password: "nope-nope-nope" },
    ]) {
      const r = await outcome(() =>
        actions.startTotp(createTestEvent({ user: u, form }) as never),
      );
      expect(r).toMatchObject({ type: "fail", status: 400 });
    }
    expect(
      (await outcome(() => load(createTestEvent({ user: u }) as never))) as {
        value: { enrolment: unknown };
      },
    ).toMatchObject({ value: { enrolment: null } });
  });

  it("confirming enrolment needs the current password even with a valid code", async () => {
    const u = await createTestUser();
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const code = totpCode(secret, Date.now());
    for (const form of [
      { code } as Record<string, string>,
      { code, password: "nope-nope-nope" },
    ]) {
      const r = await outcome(() =>
        actions.confirmTotp(createTestEvent({ user: u, form }) as never),
      );
      expect(r).toMatchObject({ type: "fail", status: 400 });
    }
    expect((await getTwoFactorStatus(u.id)).totpEnabled).toBe(false);
  });

  it("wrong enrolment passwords are rate limited", async () => {
    const u = await createTestUser();
    let last: unknown;
    for (let i = 0; i < 6; i++) {
      last = await outcome(() =>
        actions.startTotp(
          createTestEvent({
            user: u,
            form: { password: "nope-nope-nope" },
          }) as never,
        ),
      );
    }
    expect(last).toMatchObject({ type: "fail", status: 429 });
  });

  it("renames and deletes only the caller's passkeys", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const pa = await seedPasskey(a.id, "a");
    const pb = await seedPasskey(b.id, "b");

    const crossRename = await outcome(() =>
      actions.renamePasskey(
        createTestEvent({
          user: a,
          form: { id: pb.id, name: "mine now" },
        }) as never,
      ),
    );
    const crossDelete = await outcome(async () =>
      actions.deletePasskey(
        createTestEvent({ ...(await sess(a)), form: { id: pb.id } }) as never,
      ),
    );
    expect(crossRename).toMatchObject({ type: "fail", status: 400 });
    expect(crossDelete).toMatchObject({ type: "fail", status: 400 });
    expect(await getDB().select().from(passkeys)).toHaveLength(2);

    expect(
      await outcome(() =>
        actions.renamePasskey(
          createTestEvent({
            user: a,
            form: { id: pa.id, name: "Phone" },
          }) as never,
        ),
      ),
    ).toMatchObject({ type: "return" });
    expect(
      (await getDB().select().from(passkeys)).find((p) => p.id === pa.id)?.name,
    ).toBe("Phone");
    await outcome(async () =>
      actions.deletePasskey(
        createTestEvent({ ...(await sess(a)), form: { id: pa.id } }) as never,
      ),
    );
    expect(await getDB().select().from(passkeys)).toHaveLength(1);
  });

  it("validates passkey names", async () => {
    const a = await createTestUser();
    const pa = await seedPasskey(a.id);
    const r = await outcome(() =>
      actions.renamePasskey(
        createTestEvent({ user: a, form: { id: pa.id, name: " " } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });

  it("removing a passkey needs a recent step-up", async () => {
    const a = await createTestUser();
    const pa = await seedPasskey(a.id);
    for (const age of [null, REAUTH_WINDOW_MS + 1000]) {
      const r = await outcome(async () =>
        actions.deletePasskey(
          createTestEvent({
            ...(await sess(a, age)),
            form: { id: pa.id },
          }) as never,
        ),
      );
      expect(r).toMatchObject({ type: "fail", status: 403 });
    }
    expect(await getDB().select().from(passkeys)).toHaveLength(1);
  });

  it("stepUp needs the password (and a code when TOTP is on) and starts the window", async () => {
    const u = await createTestUser();
    const s = await sess(u, null);
    const wrong = await outcome(() =>
      actions.stepUp(
        createTestEvent({
          ...s,
          form: { password: "nope-nope-nope" },
        }) as never,
      ),
    );
    expect(wrong).toMatchObject({ type: "fail", status: 400 });
    expect(await hasRecentReauth(s.session.id)).toBe(false);
    const ok = await outcome(() =>
      actions.stepUp(
        createTestEvent({ ...s, form: { password: u.password } }) as never,
      ),
    );
    expect(ok).toMatchObject({ type: "return", value: { reauthed: true } });
    expect(await hasRecentReauth(s.session.id)).toBe(true);
    expect(
      await hasRecentReauth(s.session.id, Date.now() + REAUTH_WINDOW_MS + 1000),
    ).toBe(false);

    const t = await createTestUser();
    const { secret } = await startTotpEnrolment(t.id, t.username);
    await confirmTotpEnrolment(
      t.id,
      totpCode(secret, Date.now() - 600_000),
      Date.now() - 600_000,
    );
    const ts = await sess(t, null);
    const noCode = await outcome(() =>
      actions.stepUp(
        createTestEvent({ ...ts, form: { password: t.password } }) as never,
      ),
    );
    expect(noCode).toMatchObject({ type: "fail", status: 400 });
    expect(await hasRecentReauth(ts.session.id)).toBe(false);
  });

  it("passkey-only users cannot step up with the password form alone", async () => {
    const u = await createTestUser();
    await seedPasskey(u.id);
    const s = await sess(u, null);
    const r = await outcome(() =>
      actions.stepUp(
        createTestEvent({ ...s, form: { password: u.password } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
    expect(await hasRecentReauth(s.session.id)).toBe(false);
  });

  it("removing a passkey keeps this session and signs the others out", async () => {
    const u = await createTestUser();
    const pa = await seedPasskey(u.id);
    const mine = await loginTestUser(u);
    const other = await loginTestUser(u);
    await getDB()
      .update(sessions)
      .set({ reauthAt: new Date() })
      .where(eq(sessions.id, mine.session.id));
    await outcome(() =>
      actions.deletePasskey(
        createTestEvent({
          user: u,
          session: mine.session,
          form: { id: pa.id },
        }) as never,
      ),
    );
    expect(await validateSessionToken(mine.token)).not.toBeNull();
    expect(await validateSessionToken(other.token)).toBeNull();
  });

  it("disabling the authenticator app keeps this session and signs the others out", async () => {
    const u = await createTestUser();
    const past = Date.now() - 600_000;
    const { secret } = await startTotpEnrolment(u.id, u.username);
    const codes = await confirmTotpEnrolment(
      u.id,
      totpCode(secret, past),
      past,
    );
    const mine = await loginTestUser(u);
    const other = await loginTestUser(u);
    const r = await outcome(() =>
      actions.disableTotp(
        createTestEvent({
          user: u,
          session: mine.session,
          form: { password: u.password, code: codes[0] },
        }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "return" });
    expect(await validateSessionToken(mine.token)).not.toBeNull();
    expect(await validateSessionToken(other.token)).toBeNull();
  });
});
