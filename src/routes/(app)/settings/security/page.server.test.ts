import { beforeEach, describe, expect, it } from "vitest";
import { twoFactorManageLimiter } from "$lib/server/auth/rate-limit";
import { totpCode } from "$lib/server/auth/totp";
import {
  confirmTotpEnrolment,
  getTwoFactorStatus,
  startTotpEnrolment,
} from "$lib/server/auth/two-factor";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { getDB, passkeys } from "$lib/server/db";
import { actions, load } from "./+page.server";

function seedPasskey(userId: string, credentialId = "cred") {
  getDB()
    .insert(passkeys)
    .values({
      userId,
      name: "Laptop",
      credentialId,
      publicKey: "AQID",
      deviceType: "singleDevice",
      backedUp: false,
    })
    .run();
  return getDB()
    .select()
    .from(passkeys)
    .all()
    .find((p) => p.credentialId === credentialId)!;
}

describe("settings/security", () => {
  useTestDB();
  beforeEach(() => twoFactorManageLimiter.reset());

  it("load shows enrolment secret only while pending and never leaks key material", async () => {
    const u = await createTestUser();
    seedPasskey(u.id);
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
      actions.startTotp(createTestEvent({ user: u }) as never),
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
    const { secret } = startTotpEnrolment(u.id, u.username);
    const bad = await outcome(() =>
      actions.confirmTotp(
        createTestEvent({ user: u, form: { code: "000000" } }) as never,
      ),
    );
    expect(bad).toMatchObject({ type: "fail", status: 400 });
    expect(getTwoFactorStatus(u.id).totpEnabled).toBe(false);
    const ok = await outcome(() =>
      actions.confirmTotp(
        createTestEvent({
          user: u,
          form: { code: totpCode(secret, Date.now()) },
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
    const { secret } = startTotpEnrolment(u.id, u.username);
    const codes = confirmTotpEnrolment(u.id, totpCode(secret, past), past);
    const wrongPw = await outcome(() =>
      actions.disableTotp(
        createTestEvent({
          user: u,
          form: { password: "nope-nope-nope", code: codes[0] },
        }) as never,
      ),
    );
    expect(wrongPw).toMatchObject({ type: "fail", status: 400 });
    expect(getTwoFactorStatus(u.id).totpEnabled).toBe(true);
    const ok = await outcome(() =>
      actions.disableTotp(
        createTestEvent({
          user: u,
          form: { password: u.password, code: codes[1] },
        }) as never,
      ),
    );
    expect(ok).toMatchObject({ type: "return", value: { disabled: true } });
    expect(getTwoFactorStatus(u.id).totpEnabled).toBe(false);
  });

  it("starting enrolment is refused while TOTP is enabled", async () => {
    const u = await createTestUser();
    const { secret } = startTotpEnrolment(u.id, u.username);
    confirmTotpEnrolment(u.id, totpCode(secret, Date.now()));
    const r = await outcome(() =>
      actions.startTotp(createTestEvent({ user: u }) as never),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });

  it("renames and deletes only the caller's passkeys", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const pa = seedPasskey(a.id, "a");
    const pb = seedPasskey(b.id, "b");

    const crossRename = await outcome(() =>
      actions.renamePasskey(
        createTestEvent({
          user: a,
          form: { id: pb.id, name: "mine now" },
        }) as never,
      ),
    );
    const crossDelete = await outcome(() =>
      actions.deletePasskey(
        createTestEvent({ user: a, form: { id: pb.id } }) as never,
      ),
    );
    expect(crossRename).toMatchObject({ type: "fail", status: 400 });
    expect(crossDelete).toMatchObject({ type: "fail", status: 400 });
    expect(getDB().select().from(passkeys).all()).toHaveLength(2);

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
      getDB()
        .select()
        .from(passkeys)
        .all()
        .find((p) => p.id === pa.id)?.name,
    ).toBe("Phone");
    await outcome(() =>
      actions.deletePasskey(
        createTestEvent({ user: a, form: { id: pa.id } }) as never,
      ),
    );
    expect(getDB().select().from(passkeys).all()).toHaveLength(1);
  });

  it("validates passkey names", async () => {
    const a = await createTestUser();
    const pa = seedPasskey(a.id);
    const r = await outcome(() =>
      actions.renamePasskey(
        createTestEvent({ user: a, form: { id: pa.id, name: " " } }) as never,
      ),
    );
    expect(r).toMatchObject({ type: "fail", status: 400 });
  });
});
