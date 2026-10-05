import {
  afterEach,
  onTestFinished,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getChannelConfig,
  getSettings,
  listChannels,
} from "$lib/server/notifications/store";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import {
  registerNotifications,
  unregisterNotifications,
} from "$lib/server/notifications";
import { actions, load } from "./+page.server";

useTestDB();

type Form = Record<string, string>;

async function act(
  name: keyof typeof actions,
  user: TestUser | null,
  form: Form = {},
) {
  const fn = actions[name] as (e: never) => unknown;
  return outcome(() =>
    fn(
      createTestEvent({
        user,
        form,
        url: "http://kept.test/settings/notifications",
      }) as never,
    ),
  );
}

const triggers: Form = {
  billDueEnabled: "on",
  billDueDays: "5",
  billOverdueEnabled: "on",
  budgetPercent: "90",
  staleImportDays: "21",
};

describe("settings/notifications", () => {
  let user: TestUser;
  beforeEach(async () => {
    user = await createTestUser();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("loads defaults and hides email without SMTP", async () => {
    const data = (await load(
      createTestEvent({
        user,
        url: "http://kept.test/settings/notifications",
      }) as never,
    )) as {
      settings: { billDueEnabled: boolean };
      kinds: string[];
      channels: unknown[];
    };
    expect(data.settings.billDueEnabled).toBe(false);
    expect(data.kinds).toEqual(["ntfy", "webhook"]);
    expect(data.channels).toEqual([]);
  });

  it("saves trigger settings and validates ranges", async () => {
    expect((await act("saveSettings", user, triggers)).type).toBe("return");
    expect(await getSettings(user.id)).toMatchObject({
      billDueEnabled: true,
      billDueDays: 5,
      billOverdueEnabled: true,
      budgetEnabled: false,
      budgetPercent: 90,
      staleImportDays: 21,
    });
    const bad = await act("saveSettings", user, {
      ...triggers,
      billDueDays: "0",
    });
    expect(bad.type).toBe("fail");
  });

  it("requires authentication", async () => {
    await expect(
      act("saveSettings", null, triggers),
    ).resolves.not.toMatchObject({
      type: "return",
    });
  });

  it("stores a channel encrypted, keeps a blank secret and rejects bad input", async () => {
    const save = (over: Form = {}) =>
      act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "https://ntfy.example.org/",
        topic: "kept",
        token: "tk_secret",
        ...over,
      });
    expect((await save()).type).toBe("return");
    expect((await save({ token: "", topic: "kept2" })).type).toBe("return");
    expect(await getChannelConfig(user.id, "ntfy")).toEqual({
      serverUrl: "https://ntfy.example.org",
      topic: "kept2",
      token: "tk_secret",
    });
    expect((await save({ serverUrl: "ftp://x" })).type).toBe("fail");
    expect((await save({ topic: "bad topic!" })).type).toBe("fail");
  });

  it("does not carry the ntfy token to another origin, but keeps it on the same one", async () => {
    const base = { kind: "ntfy", topic: "kept" };
    await act("saveChannel", user, {
      ...base,
      serverUrl: "https://ntfy.example.org",
      token: "tk_secret",
    });

    const moved = await act("saveChannel", user, {
      ...base,
      serverUrl: "https://ntfy.example.net",
    });
    expect(moved.type).toBe("fail");
    expect(JSON.stringify(moved)).toContain("token");
    expect(await getChannelConfig(user.id, "ntfy")).toMatchObject({
      serverUrl: "https://ntfy.example.org",
      token: "tk_secret",
    });

    for (const serverUrl of [
      "http://ntfy.example.org",
      "https://ntfy.example.org:8443",
    ]) {
      const res = await act("saveChannel", user, { ...base, serverUrl });
      expect(res.type, serverUrl).toBe("fail");
    }

    const samePath = await act("saveChannel", user, {
      ...base,
      serverUrl: "https://ntfy.example.org/prefix",
    });
    expect(samePath.type).toBe("return");
    expect(await getChannelConfig(user.id, "ntfy")).toMatchObject({
      token: "tk_secret",
    });

    const fresh = await act("saveChannel", user, {
      ...base,
      serverUrl: "https://ntfy.example.net",
      token: "tk_new",
    });
    expect(fresh.type).toBe("return");
    expect(await getChannelConfig(user.id, "ntfy")).toMatchObject({
      serverUrl: "https://ntfy.example.net",
      token: "tk_new",
    });

    const dropped = await act("saveChannel", user, {
      ...base,
      serverUrl: "https://ntfy.example.org",
      removeSecret: "on",
    });
    expect(dropped.type).toBe("return");
    expect((await getChannelConfig(user.id, "ntfy"))?.token).toBeUndefined();
  });

  it("refuses the email channel when SMTP is not configured", async () => {
    const res = await act("saveChannel", user, {
      kind: "email",
      to: "me@example.org",
    });
    expect(res.type).toBe("fail");
    expect(await listChannels(user.id)).toEqual([]);
  });

  it("limits the email channel to administrators", async () => {
    vi.stubEnv("KEPT_SMTP_HOST", "smtp.example.org");
    vi.stubEnv("KEPT_SMTP_FROM", "kept@example.org");
    registerNotifications({ firstRunDelayMs: 3_600_000 });
    onTestFinished(unregisterNotifications);
    const form = { kind: "email", to: "someone@example.org" };

    const refused = await act("saveChannel", user, form);
    expect(refused.type).toBe("fail");
    expect(await listChannels(user.id)).toEqual([]);
    const memberLoad = (await load(
      createTestEvent({
        user,
        url: "http://kept.test/settings/notifications",
      }) as never,
    )) as { kinds: string[] };
    expect(memberLoad.kinds).not.toContain("email");

    const admin = await createTestUser({ role: "admin" });
    expect((await act("saveChannel", admin, form)).type).toBe("return");
    const adminLoad = (await load(
      createTestEvent({
        user: admin,
        url: "http://kept.test/settings/notifications",
      }) as never,
    )) as { kinds: string[] };
    expect(adminLoad.kinds).toContain("email");
  });

  it("sends a test message, toggles and deletes", async () => {
    await act("saveChannel", user, {
      kind: "webhook",
      url: "https://hooks.example.org/k",
      secret: "s",
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = (await act("testChannel", user, { kind: "webhook" })) as {
      value: { result: { ok: boolean } };
    };
    expect(res.value.result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act("toggleChannel", user, { kind: "webhook", enabled: "false" });
    expect((await listChannels(user.id))[0].enabled).toBe(false);
    await act("deleteChannel", user, { kind: "webhook" });
    expect(await listChannels(user.id)).toEqual([]);
  });

  describe("private network targets", () => {
    const privateHook = {
      kind: "webhook",
      url: "http://127.0.0.1:9000/hook",
    };

    it("are refused for members by default", async () => {
      vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "");
      const res = await act("saveChannel", user, privateHook);
      expect(res.type).toBe("fail");
      expect(await listChannels(user.id)).toEqual([]);
      const meta = await act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "http://169.254.169.254",
        topic: "kept",
      });
      expect(meta.type).toBe("fail");
    });

    it("are accepted for administrators", async () => {
      vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "");
      const admin = await createTestUser({ role: "admin" });
      const res = await act("saveChannel", admin, privateHook);
      expect(res.type).toBe("return");
      expect(await listChannels(admin.id)).toHaveLength(1);
    });

    it("are accepted for members with KEPT_ALLOW_PRIVATE_NETWORK=true", async () => {
      vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "true");
      const res = await act("saveChannel", user, privateHook);
      expect(res.type).toBe("return");
    });

    it("are refused for administrators when KEPT_NOTIFY_BLOCK_PRIVATE=true", async () => {
      vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "");
      vi.stubEnv("KEPT_NOTIFY_BLOCK_PRIVATE", "true");
      const admin = await createTestUser({ role: "admin" });
      const res = await act("saveChannel", admin, privateHook);
      expect(res.type).toBe("fail");
    });

    it("are refused again at send time if a member's channel already points inside", async () => {
      vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "true");
      await act("saveChannel", user, privateHook);
      vi.stubEnv("KEPT_ALLOW_PRIVATE_NETWORK", "");
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const res = (await act("testChannel", user, { kind: "webhook" })) as {
        value: { result: { ok: boolean } };
      };
      expect(res.value.result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("never touches another user's channels", async () => {
    const other = await createTestUser();
    await act("saveChannel", other, {
      kind: "webhook",
      url: "https://hooks.example.org/k",
    });
    await act("deleteChannel", user, { kind: "webhook" });
    expect(await listChannels(other.id)).toHaveLength(1);
  });

  describe("after KEPT_SECRET_KEY changed", () => {
    const keyA = Buffer.alloc(32, 1).toString("base64");
    const keyB = Buffer.alloc(32, 2).toString("base64");

    async function brokenChannel() {
      vi.stubEnv("KEPT_SECRET_KEY", keyA);
      await act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "https://ntfy.example.org",
        topic: "kept",
        token: "tk_secret",
      });
      vi.stubEnv("KEPT_SECRET_KEY", keyB);
    }

    it("load does not throw and flags the channel", async () => {
      await brokenChannel();
      const data = (await load(
        createTestEvent({
          user,
          url: "http://kept.test/settings/notifications",
        }) as never,
      )) as { channels: { kind: string; needsReentry: boolean }[] };
      expect(data.channels).toEqual([
        expect.objectContaining({ kind: "ntfy", needsReentry: true }),
      ]);
    });

    it("re-saving with a blank token is refused instead of silently dropping the secret", async () => {
      await brokenChannel();
      const res = await act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "https://ntfy.example.org",
        topic: "kept2",
      });
      expect(res.type).toBe("fail");
      expect(JSON.stringify(res)).toContain("Enter it again");
      expect((await listChannels(user.id))[0]).toMatchObject({
        needsReentry: true,
      });
    });

    it("re-saving with a new token stores it", async () => {
      await brokenChannel();
      const res = await act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "https://ntfy.example.org",
        topic: "kept2",
        token: "tk_new",
      });
      expect(res.type).toBe("return");
      expect((await listChannels(user.id))[0]).toMatchObject({
        needsReentry: false,
        fields: { topic: "kept2" },
        hasSecret: true,
      });
    });

    it("the secret can be removed explicitly", async () => {
      await brokenChannel();
      const res = await act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "https://ntfy.example.org",
        topic: "kept2",
        removeSecret: "on",
      });
      expect(res.type).toBe("return");
      expect((await listChannels(user.id))[0]).toMatchObject({
        needsReentry: false,
        fields: { topic: "kept2" },
        hasSecret: false,
      });
    });

    it("the same rule holds for the webhook signing secret", async () => {
      vi.stubEnv("KEPT_SECRET_KEY", keyA);
      await act("saveChannel", user, {
        kind: "webhook",
        url: "https://hooks.example.org/k",
        secret: "sig",
      });
      vi.stubEnv("KEPT_SECRET_KEY", keyB);
      const refused = await act("saveChannel", user, {
        kind: "webhook",
        url: "https://hooks.example.org/k",
      });
      expect(refused.type).toBe("fail");
      expect(JSON.stringify(refused)).toContain("secret");
      const ok = await act("saveChannel", user, {
        kind: "webhook",
        url: "https://hooks.example.org/k",
        removeSecret: "on",
      });
      expect(ok.type).toBe("return");
    });

    it("a first save without a secret is unaffected", async () => {
      vi.stubEnv("KEPT_SECRET_KEY", keyB);
      const res = await act("saveChannel", user, {
        kind: "ntfy",
        serverUrl: "https://ntfy.example.org",
        topic: "kept",
      });
      expect(res.type).toBe("return");
    });

    it("the channel can be removed, and toggling does not throw", async () => {
      await brokenChannel();
      expect(
        (await act("toggleChannel", user, { kind: "ntfy", enabled: "false" }))
          .type,
      ).toBe("return");
      expect((await act("deleteChannel", user, { kind: "ntfy" })).type).toBe(
        "return",
      );
      expect(await listChannels(user.id)).toEqual([]);
    });
  });
});
