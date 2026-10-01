import { afterEach, describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { load } from "./+page.server";
import { GET } from "./download/+server";

useTestDB();

const ev = (opts: Parameters<typeof createTestEvent>[0]) =>
  createTestEvent(opts) as never;

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
      value: { scheduled: null },
    });
  });
});

describe("backup download", () => {
  it("rejects members", async () => {
    const member = await createTestUser();
    expect(await outcome(() => GET(ev({ user: member })))).toEqual({
      type: "error",
      status: 403,
    });
  });

  it("serves the database as an attachment to admins", async () => {
    const admin = await createTestUser({ role: "admin" });
    const res = (await GET(ev({ user: admin }))) as Response;
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="kept-backup-\d{8}-\d{6}\.db"$/,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe(
      "SQLite format 3",
    );
    expect(Number(res.headers.get("content-length"))).toBe(bytes.byteLength);
  });
});
