import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChannelConfig,
  getSettings,
  listChannels,
} from "$lib/server/notifications/store";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
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
    expect(getSettings(user.id)).toMatchObject({
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
    expect(getChannelConfig(user.id, "ntfy")).toEqual({
      serverUrl: "https://ntfy.example.org",
      topic: "kept2",
      token: "tk_secret",
    });
    expect((await save({ serverUrl: "ftp://x" })).type).toBe("fail");
    expect((await save({ topic: "bad topic!" })).type).toBe("fail");
  });

  it("refuses the email channel when SMTP is not configured", async () => {
    const res = await act("saveChannel", user, {
      kind: "email",
      to: "me@example.org",
    });
    expect(res.type).toBe("fail");
    expect(listChannels(user.id)).toEqual([]);
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
    expect(listChannels(user.id)[0].enabled).toBe(false);
    await act("deleteChannel", user, { kind: "webhook" });
    expect(listChannels(user.id)).toEqual([]);
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
      expect(listChannels(user.id)).toEqual([]);
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
      expect(listChannels(admin.id)).toHaveLength(1);
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
    expect(listChannels(other.id)).toHaveLength(1);
  });
});
