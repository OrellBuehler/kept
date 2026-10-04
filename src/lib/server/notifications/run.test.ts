import type { FetchFn } from "./channels/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "$lib/server/crypto";
import { getDB, notificationChannels, notificationsSent } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { seedAccount } from "$lib/testing/ledger";
import { sendTest } from "./dispatch";
import { runNotifications } from "./run";
import {
  getChannelConfig,
  listChannels,
  saveChannel,
  saveSettings,
} from "./store";
import { DEFAULT_SETTINGS } from "./types";

useTestDB();

const NOW = new Date(2026, 9, 3, 9, 0, 0);

const okFetch = () =>
  vi.fn<FetchFn>(async () => new Response(null, { status: 200 }));
const sentCount = () => getDB().select().from(notificationsSent).all().length;

async function setup() {
  const user = await createTestUser();
  saveSettings(user.id, { ...DEFAULT_SETTINGS, billOverdueEnabled: true });
  saveChannel(user.id, "ntfy", {
    serverUrl: "https://ntfy.example.org",
    topic: "kept",
    token: "tk_secret",
  });
  return user;
}

afterEach(() => vi.restoreAllMocks());

describe("runNotifications", () => {
  it("notifies once per event and never again", async () => {
    const user = await setup();
    seedBill(user.id, { dueDate: "2026-09-20" });
    const fetchFn = okFetch();

    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.title).toBe("Bill overdue");
    expect(body.message).toContain("Example Supplier");
    expect(sentCount()).toBe(1);

    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    seedBill(user.id, { dueDate: "2026-09-25" });
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sentCount()).toBe(2);
  });

  it("batches several new events into one message", async () => {
    const user = await setup();
    seedBill(user.id, { dueDate: "2026-09-20" });
    seedBill(user.id, { dueDate: "2026-09-21" });
    const fetchFn = okFetch();
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)).title).toBe(
      "Kept: 2 notifications",
    );
    expect(sentCount()).toBe(2);
  });

  it("keeps events unsent when delivery fails, records the error and retries", async () => {
    const user = await setup();
    seedBill(user.id, { dueDate: "2026-09-20" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn<FetchFn>(
      async () => new Response(null, { status: 500 }),
    );

    await runNotifications({ fetch: failing, smtp: null }, NOW);
    expect(sentCount()).toBe(0);
    const [view] = listChannels(user.id);
    expect(view.lastError).toContain("5xx");
    expect(view.lastSuccessAt).toBeNull();
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain("Example Supplier");
    expect(logged).not.toContain("tk_secret");

    const fetchFn = okFetch();
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sentCount()).toBe(1);
    expect(listChannels(user.id)[0].lastError).toBeNull();
  });

  it("does nothing without enabled channels or enabled triggers", async () => {
    const user = await setup();
    seedBill(user.id, { dueDate: "2026-09-20" });
    const fetchFn = okFetch();
    getDB().update(notificationChannels).set({ enabled: false }).run();
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    getDB().update(notificationChannels).set({ enabled: true }).run();
    saveSettings(user.id, DEFAULT_SETTINGS);
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("only looks at the user's own data", async () => {
    const user = await setup();
    const other = await createTestUser();
    seedBill(other.id, { dueDate: "2026-09-20" });
    const fetchFn = okFetch();
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(user.id).not.toBe(other.id);
  });

  it("notifies stale accounts", async () => {
    const user = await createTestUser();
    saveSettings(user.id, {
      ...DEFAULT_SETTINGS,
      staleImportEnabled: true,
      staleImportDays: 7,
    });
    saveChannel(user.id, "webhook", { url: "https://hooks.example.org/k" });
    seedAccount(user.id, { name: "Main" });
    const fetchFn = okFetch();
    await runNotifications(
      { fetch: fetchFn, smtp: null },
      new Date(2026 + 1, 0, 1),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("channels", () => {
  it("stores the configuration encrypted and hides secrets from views", async () => {
    const user = await setup();
    const row = getDB().select().from(notificationChannels).get()!;
    expect(row.configEncrypted).not.toContain("tk_secret");
    expect(JSON.parse(decryptSecret(row.configEncrypted)).token).toBe(
      "tk_secret",
    );
    expect(getChannelConfig(user.id, "ntfy")?.topic).toBe("kept");
    const [view] = listChannels(user.id);
    expect(view.hasSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain("tk_secret");
  });

  it("sends a test message and records the outcome", async () => {
    const user = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await sendTest(user.id, "ntfy", {
      fetch: okFetch(),
      smtp: null,
    });
    expect(ok).toEqual({ ok: true });
    expect(listChannels(user.id)[0].lastSuccessAt).not.toBeNull();

    const bad = await sendTest(user.id, "ntfy", {
      fetch: vi.fn<FetchFn>(async () => new Response(null, { status: 401 })),
      smtp: null,
    });
    expect(bad.ok).toBe(false);
    expect(listChannels(user.id)[0].lastError).toContain("credentials");
  });

  it("refuses the email channel when SMTP is not configured", async () => {
    const user = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    saveChannel(user.id, "email", { to: "me@example.org" });
    const res = await sendTest(user.id, "email", { smtp: null });
    expect(res).toMatchObject({ ok: false });
  });
});

describe("channels encrypted with another KEPT_SECRET_KEY", () => {
  const keyA = Buffer.alloc(32, 1).toString("base64");
  const keyB = Buffer.alloc(32, 2).toString("base64");
  afterEach(() => vi.unstubAllEnvs());

  async function withUnreadable() {
    vi.stubEnv("KEPT_SECRET_KEY", keyA);
    const user = await setup();
    vi.stubEnv("KEPT_SECRET_KEY", keyB);
    return user;
  }

  it("are listed as needing re-entry without throwing and without leaking anything", async () => {
    const user = await withUnreadable();
    const [view] = listChannels(user.id);
    expect(view).toMatchObject({
      kind: "ntfy",
      enabled: true,
      needsReentry: true,
      fields: {},
      hasSecret: false,
    });
  });

  it("are skipped when sending: nothing is fetched, nothing is marked sent, only a code is logged", async () => {
    const user = await withUnreadable();
    seedBill(user.id, { dueDate: "2026-09-20" });
    const fetchFn = okFetch();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sentCount()).toBe(0);
    const logged = JSON.stringify([errors.mock.calls, warns.mock.calls]);
    expect(logged).not.toContain("tk_secret");
    expect(logged).not.toContain("ntfy.example.org");
  });

  it("sendTest reports that the settings must be entered again", async () => {
    const user = await withUnreadable();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendTest(user.id, "ntfy", { fetch: okFetch(), smtp: null });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/again|re-enter/i);
  });

  it("deliver skips an unreadable channel but still uses a readable one", async () => {
    const user = await withUnreadable();
    saveChannel(user.id, "webhook", { url: "https://hooks.example.org/k" });
    const fetchFn = okFetch();
    seedBill(user.id, { dueDate: "2026-09-20" });
    await runNotifications({ fetch: fetchFn, smtp: null }, NOW);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      "https://hooks.example.org/k",
    );
    expect(sentCount()).toBe(1);
  });

  it("saving the channel again makes it work", async () => {
    const user = await withUnreadable();
    saveChannel(user.id, "ntfy", {
      serverUrl: "https://ntfy.example.org",
      topic: "kept",
    });
    expect(listChannels(user.id)[0]).toMatchObject({ needsReentry: false });
  });
});
