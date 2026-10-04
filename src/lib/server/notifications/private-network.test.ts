import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDB, users } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import type { FetchFn } from "./channels/http";
import { deliver, sendTest } from "./dispatch";
import { listChannels, saveChannel } from "./store";

useTestDB();

const hook = { url: "http://127.0.0.1:9000/hook" };
const message = { title: "Example", body: "Example body" };
const okFetch = () =>
  vi.fn<FetchFn>(async () => new Response(null, { status: 200 }));

describe("notification delivery with KEPT_ALLOW_PRIVATE_NETWORK cleared", () => {
  beforeEach(() => vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", ""));
  afterEach(() => {
    vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "true");
    vi.restoreAllMocks();
  });

  it("deliver never reaches a member's stored private target", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const member = await createTestUser();
    saveChannel(member.id, "webhook", hook);
    const fetchFn = okFetch();

    expect(
      await deliver(member.id, message, { fetch: fetchFn, smtp: null }),
    ).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(listChannels(member.id)[0]!.lastError).toBeTruthy();
  });

  it("sendTest is refused the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const member = await createTestUser();
    saveChannel(member.id, "webhook", hook);
    const fetchFn = okFetch();

    const res = await sendTest(member.id, "webhook", {
      fetch: fetchFn,
      smtp: null,
    });
    expect(res.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an administrator is allowed, and blocked after losing the role", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = await createTestUser({ role: "admin" });
    saveChannel(admin.id, "webhook", hook);
    const fetchFn = okFetch();
    expect(
      await deliver(admin.id, message, { fetch: fetchFn, smtp: null }),
    ).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    getDB()
      .update(users)
      .set({ role: "member" })
      .where(eq(users.id, admin.id))
      .run();
    expect(
      await deliver(admin.id, message, { fetch: fetchFn, smtp: null }),
    ).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("another user's allowance does not apply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    saveChannel(admin.id, "webhook", hook);
    saveChannel(member.id, "webhook", hook);
    const fetchFn = okFetch();
    expect(
      await deliver(member.id, message, { fetch: fetchFn, smtp: null }),
    ).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
