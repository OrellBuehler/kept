import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  issueDownloadToken,
  resetDownloadTokens,
} from "$lib/server/auth/admin-confirm";
import { adminActionLimiter } from "$lib/server/auth/rate-limit";
import { adminAuditLog, getDB } from "$lib/server/db";
import { addPasskey, createTestUser, enableTotp } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";
import { GET } from "./download/+server";

useTestDB();

const ev = (opts: Parameters<typeof createTestEvent>[0]) =>
  createTestEvent(opts) as never;

beforeEach(() => {
  adminActionLimiter.reset();
  resetDownloadTokens();
});

afterEach(() => {
  delete process.env.KEPT_BACKUP_DIR;
});

describe("backup page", () => {
  it("is admin only", async () => {
    const member = await createTestUser();
    expect(await outcome(() => load(ev({ user: member })))).toEqual({
      type: "error",
      status: 403,
    });
  });

  it("reports scheduled backups as off by default", async () => {
    const admin = await createTestUser({ role: "admin" });
    expect(await outcome(() => load(ev({ user: admin })))).toEqual({
      type: "return",
      value: { scheduled: null, confirmMode: "password" },
    });
  });
});

const tokenFrom = (url: string) =>
  new URL(url, "http://localhost").searchParams.get("token");

describe("backup download", () => {
  it("rejects members", async () => {
    const member = await createTestUser();
    expect(await outcome(() => GET(ev({ user: member })))).toEqual({
      type: "error",
      status: 403,
    });
  });

  it("rejects an admin without a confirmed token", async () => {
    const admin = await createTestUser({ role: "admin" });
    for (const url of [
      "http://localhost/admin/backup/download",
      "http://localhost/admin/backup/download?token=guess",
    ]) {
      expect(await outcome(() => GET(ev({ user: admin, url })))).toEqual({
        type: "error",
        status: 403,
      });
    }
    expect(getDB().select().from(adminAuditLog).all()).toHaveLength(0);
  });

  it("the download action needs the admin's password", async () => {
    const admin = await createTestUser({ role: "admin" });
    for (const form of [
      {} as Record<string, string>,
      { adminPassword: "nope-nope" },
    ]) {
      const r = await outcome(() =>
        actions.download(ev({ user: admin, form })),
      );
      expect(r).toMatchObject({ type: "fail", status: 400 });
    }
    const member = await createTestUser();
    expect(
      await outcome(() =>
        actions.download(
          ev({ user: member, form: { adminPassword: member.password } }),
        ),
      ),
    ).toEqual({ type: "error", status: 403 });
  });

  it("wrong passwords on the download action are rate limited", async () => {
    const admin = await createTestUser({ role: "admin" });
    let last: unknown;
    for (let i = 0; i < 6; i++) {
      last = await outcome(() =>
        actions.download(
          ev({ user: admin, form: { adminPassword: "nope-nope-nope" } }),
        ),
      );
    }
    expect(last).toMatchObject({ type: "fail", status: 429 });
  });

  it("serves the database once after confirmation and records it", async () => {
    const admin = await createTestUser({ role: "admin", username: "boss" });
    const confirmed = (await outcome(() =>
      actions.download(
        ev({ user: admin, form: { adminPassword: admin.password } }),
      ),
    )) as { value: { downloadUrl: string } };
    const url = `http://localhost${confirmed.value.downloadUrl}`;
    const res = (await GET(ev({ user: admin, url }))) as Response;
    // the audit row exists before a single byte is read
    expect(
      getDB()
        .select()
        .from(adminAuditLog)
        .all()
        .filter((r) => r.action === "backup_download"),
    ).toHaveLength(1);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kept-backup-\d{8}-\d{6}\.db"$/,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe(
      "SQLite format 3",
    );
    expect(Number(res.headers.get("content-length"))).toBe(bytes.byteLength);

    const rows = getDB().select().from(adminAuditLog).all();
    expect(rows.map((r) => r.action).sort()).toEqual([
      "backup_download",
      "backup_link_issued",
    ]);
    expect(rows.find((r) => r.action === "backup_download")).toMatchObject({
      actorUserId: admin.id,
      actorUsername: "boss",
      details: "outcome=started",
    });

    expect(await outcome(() => GET(ev({ user: admin, url })))).toEqual({
      type: "error",
      status: 403,
    });
  });

  it("records failed confirmations and rate-limit hits, but no link", async () => {
    const admin = await createTestUser({ role: "admin" });
    for (let i = 0; i < 8; i++) {
      await outcome(() =>
        actions.download(
          ev({ user: admin, form: { adminPassword: "nope-nope-nope" } }),
        ),
      );
    }
    const seen = getDB()
      .select()
      .from(adminAuditLog)
      .all()
      .map((r) => r.action);
    expect(seen.filter((a) => a === "admin_confirm_failed")).toHaveLength(5);
    expect(seen.filter((a) => a === "admin_confirm_rate_limited")).toHaveLength(
      1,
    );
    expect(seen).not.toContain("backup_link_issued");
  });

  it("an administrator with an authenticator app must also give a code", async () => {
    const admin = await createTestUser({ role: "admin" });
    const [recovery] = enableTotp(admin);
    const refused = await outcome(() =>
      actions.download(
        ev({ user: admin, form: { adminPassword: admin.password } }),
      ),
    );
    expect(refused).toMatchObject({ type: "fail", status: 400 });
    expect(JSON.stringify(refused)).toContain("adminCode");
    const ok = await outcome(() =>
      actions.download(
        ev({
          user: admin,
          form: { adminPassword: admin.password, adminCode: recovery },
        }),
      ),
    );
    expect(ok).toMatchObject({ type: "return" });
  });

  it("a passkey-only administrator needs a recent passkey step-up", async () => {
    const admin = await createTestUser({ role: "admin" });
    addPasskey(admin.id);
    const refused = await outcome(() =>
      actions.download(
        ev({ user: admin, form: { adminPassword: admin.password } }),
      ),
    );
    expect(refused).toMatchObject({ type: "fail", status: 400 });
    expect(getDB().select().from(adminAuditLog).all()).toHaveLength(0);
  });

  it("a token is bound to the admin it was issued to", async () => {
    const a = await createTestUser({ role: "admin" });
    const b = await createTestUser({ role: "admin" });
    const token = issueDownloadToken(a.id);
    expect(tokenFrom(`/x?token=${token}`)).toBe(token);
    expect(
      await outcome(() =>
        GET(ev({ user: b, url: `http://localhost/d?token=${token}` })),
      ),
    ).toEqual({ type: "error", status: 403 });
  });
});
