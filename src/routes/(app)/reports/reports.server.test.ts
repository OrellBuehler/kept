import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount } from "$lib/testing/ledger";
import { load } from "./+page.server";
import { GET } from "./[kind]/+server";

type User = Awaited<ReturnType<typeof createTestUser>>;
const get = (user: User, kind: string, query = "") =>
  outcome(() =>
    GET(
      createTestEvent({
        user,
        params: { kind },
        url: `http://localhost/reports/${kind}${query}`,
      }) as never,
    ),
  );

describe("reports page", () => {
  useTestDB();

  it("lists only the user's accounts", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const a = await seedAccount(u.id, { name: "Mine" });
    await seedAccount(other.id, { name: "Theirs" });
    const r = await outcome(() => load(createTestEvent({ user: u }) as never));
    expect(r.type).toBe("return");
    const value = (r as { value: { accounts: unknown[] } }).value;
    expect(value.accounts).toEqual([
      expect.objectContaining({ id: a.id, name: "Mine", archived: false }),
    ]);
  });
});

describe("report download", () => {
  useTestDB();

  it("serves each kind as an attachment PDF", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id);
    seedBill(u.id);
    const cases: [string, string][] = [
      ["statement", `?account=${a.id}&from=2026-09-01&to=2026-09-30`],
      ["bills", ""],
      ["net-worth", ""],
    ];
    for (const [kind, query] of cases) {
      const r = await get(u, kind, query);
      expect(r.type, kind).toBe("return");
      const res = (r as { value: Response }).value;
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Content-Disposition")).toMatch(
        new RegExp(
          `^attachment; filename="kept-${kind}-\\d{4}-\\d{2}-\\d{2}\\.pdf"$`,
        ),
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    }
  });

  it("answers 404 for unknown kinds and other users' accounts", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id);
    const period = "from=2026-09-01&to=2026-09-30";
    expect(await get(u, "payroll")).toEqual({ type: "error", status: 404 });
    expect(
      await get(u, "statement", `?account=${theirs.id}&${period}`),
    ).toEqual({ type: "error", status: 404 });
    expect(await get(u, "statement", `?account=missing&${period}`)).toEqual({
      type: "error",
      status: 404,
    });
  });

  it("answers 400 for bad parameters", async () => {
    const u = await createTestUser();
    const a = await seedAccount(u.id);
    for (const query of [
      "",
      `?account=${a.id}`,
      `?account=${a.id}&from=nope&to=2026-09-30`,
      `?account=${a.id}&from=2026-10-01&to=2026-09-30`,
    ]) {
      expect(await get(u, "statement", query), query).toEqual({
        type: "error",
        status: 400,
      });
    }
  });
});
