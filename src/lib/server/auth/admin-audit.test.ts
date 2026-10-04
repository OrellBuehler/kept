import { describe, expect, it } from "vitest";
import { adminAuditLog } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  listAdminAuditLog,
  recordAdminAction,
  recordConfirmationRateLimited,
} from "./admin-audit";
import { WINDOW_MS } from "./rate-limit";

const T0 = Date.now();

describe("admin audit", () => {
  const ctx = useTestDB();

  async function limitedRows() {
    return (await ctx.db.select().from(adminAuditLog)).filter(
      (r) => r.action === "admin_confirm_rate_limited",
    );
  }

  it("writes one rate-limited row per window even for parallel refusals", async () => {
    const admin = await createTestUser({ role: "admin" });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordConfirmationRateLimited(admin, T0),
      ),
    );
    expect(await limitedRows()).toHaveLength(1);
  });

  it("writes again after the window and keeps administrators apart", async () => {
    const a = await createTestUser({ role: "admin" });
    const b = await createTestUser({ role: "admin" });
    await recordConfirmationRateLimited(a, T0);
    await recordConfirmationRateLimited(b, T0 + 1000);
    expect(await limitedRows()).toHaveLength(2);
    await recordConfirmationRateLimited(a, T0 + 1000);
    expect(await limitedRows()).toHaveLength(2);
    await recordConfirmationRateLimited(a, T0 + 2 * WINDOW_MS);
    expect(await limitedRows()).toHaveLength(3);
  });

  it("lists newest first for administrators and refuses everyone else", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    await recordAdminAction(admin, "backup_download", {
      details: "outcome=started",
    });
    await recordAdminAction(admin, "backup_link_issued");
    const log = await listAdminAuditLog(admin);
    expect(log).toHaveLength(2);
    expect(log[0].actorUsername).toBe(admin.username);
    await expect(listAdminAuditLog(member)).rejects.toThrow(/Administrator/);
  });
});
