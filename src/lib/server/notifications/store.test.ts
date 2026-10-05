import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  deleteChannel,
  getChannelConfig,
  getSettings,
  listChannels,
  markSent,
  saveChannel,
  saveSettings,
  sentKeys,
  setChannelEnabled,
  usersWithTriggers,
} from "./store";
import { DEFAULT_SETTINGS } from "./types";

useTestDB();

afterEach(() => vi.unstubAllEnvs());

const ntfy = (over: { topic?: string; token?: string } = {}) => ({
  serverUrl: "https://ntfy.example.org",
  topic: "kept",
  ...over,
});

describe("saveChannel", () => {
  it("keeps the stored secret when the new settings leave it out", async () => {
    const u = await createTestUser();
    await saveChannel(u.id, "ntfy", ntfy({ token: "tk_one" }));
    const saved = await saveChannel(u.id, "ntfy", ntfy({ topic: "other" }), {
      keepSecret: "token",
    });
    expect(saved).toEqual({ ok: true });
    expect(await getChannelConfig(u.id, "ntfy")).toEqual(
      ntfy({ topic: "other", token: "tk_one" }),
    );
  });

  it("replaces the secret when a new one is given", async () => {
    const u = await createTestUser();
    await saveChannel(u.id, "ntfy", ntfy({ token: "tk_one" }));
    await saveChannel(u.id, "ntfy", ntfy({ token: "tk_two" }), {
      keepSecret: "token",
    });
    expect((await getChannelConfig(u.id, "ntfy"))?.token).toBe("tk_two");
  });

  it("stores no secret when there is nothing to keep", async () => {
    const u = await createTestUser();
    const saved = await saveChannel(u.id, "ntfy", ntfy(), {
      keepSecret: "token",
    });
    expect(saved).toEqual({ ok: true });
    expect(await getChannelConfig(u.id, "ntfy")).toEqual(ntfy());
  });

  it("never reads another user's secret to keep", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await saveChannel(a.id, "ntfy", ntfy({ token: "tk_a" }));
    await saveChannel(b.id, "ntfy", ntfy(), { keepSecret: "token" });
    expect(await getChannelConfig(b.id, "ntfy")).toEqual(ntfy());
    expect((await getChannelConfig(a.id, "ntfy"))?.token).toBe("tk_a");
  });

  describe("when the stored secret cannot be decrypted", () => {
    const keyA = Buffer.alloc(32, 1).toString("base64");
    const keyB = Buffer.alloc(32, 2).toString("base64");

    async function unreadable() {
      vi.stubEnv("KEPT_SECRET_KEY", keyA);
      const u = await createTestUser();
      await saveChannel(u.id, "ntfy", ntfy({ token: "tk_one" }));
      vi.stubEnv("KEPT_SECRET_KEY", keyB);
      return u;
    }

    it("writes nothing unless dropping it is allowed", async () => {
      const u = await unreadable();
      const saved = await saveChannel(u.id, "ntfy", ntfy({ topic: "other" }), {
        keepSecret: "token",
      });
      expect(saved).toEqual({ ok: false, reason: "secret_unreadable" });
      expect((await listChannels(u.id))[0]).toMatchObject({
        needsReentry: true,
      });
    });

    it("drops it when allowed and the new settings are readable", async () => {
      const u = await unreadable();
      const saved = await saveChannel(u.id, "ntfy", ntfy({ topic: "other" }), {
        keepSecret: "token",
        dropUnreadableSecret: true,
      });
      expect(saved).toEqual({ ok: true });
      expect(await getChannelConfig(u.id, "ntfy")).toEqual(
        ntfy({ topic: "other" }),
      );
    });

    it("accepts a newly entered secret without any option", async () => {
      const u = await unreadable();
      const saved = await saveChannel(u.id, "ntfy", ntfy({ token: "tk_new" }), {
        keepSecret: "token",
      });
      expect(saved).toEqual({ ok: true });
      expect((await getChannelConfig(u.id, "ntfy"))?.token).toBe("tk_new");
    });
  });
});

describe("channel state is scoped to the user", () => {
  it("toggles and deletes only the caller's channel", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await saveChannel(a.id, "ntfy", ntfy({ token: "tk_a" }));
    await saveChannel(b.id, "ntfy", ntfy({ token: "tk_b" }));
    await setChannelEnabled(a.id, "ntfy", false);
    expect((await listChannels(a.id))[0]!.enabled).toBe(false);
    expect((await listChannels(b.id))[0]!.enabled).toBe(true);
    await deleteChannel(a.id, "ntfy");
    expect(await listChannels(a.id)).toEqual([]);
    expect(await listChannels(b.id)).toHaveLength(1);
  });
});

describe("trigger settings and sent keys", () => {
  it("defaults, saves and lists per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    expect(await getSettings(a.id)).toEqual(DEFAULT_SETTINGS);
    await saveSettings(a.id, { ...DEFAULT_SETTINGS, billOverdueEnabled: true });
    await saveSettings(a.id, { ...DEFAULT_SETTINGS, billOverdueEnabled: true });
    expect((await getSettings(a.id)).billOverdueEnabled).toBe(true);
    expect(await getSettings(b.id)).toEqual(DEFAULT_SETTINGS);
    expect((await usersWithTriggers()).map((u) => u.userId)).toEqual([a.id]);
  });

  it("marks keys idempotently and keeps them per user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await markSent(a.id, ["k1", "k2"]);
    await markSent(a.id, ["k2", "k3"]);
    await markSent(a.id, []);
    expect([...(await sentKeys(a.id))].sort()).toEqual(["k1", "k2", "k3"]);
    expect(await sentKeys(b.id)).toEqual(new Set());
  });
});
