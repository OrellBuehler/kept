import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelError } from "../types";
import {
  assertAllowedUrl,
  blockPrivateEnabled,
  isPrivateAddress,
  type Lookup,
} from "./guard";
import { ntfyChannel } from "./ntfy";

const on = { KEPT_NOTIFY_BLOCK_PRIVATE: "true" };
const resolvesTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

afterEach(() => vi.unstubAllEnvs());

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.5",
  ])("%s is private", (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each([
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "fec0::1",
  ])("%s is public", (a) => expect(isPrivateAddress(a)).toBe(false));
});

describe("assertAllowedUrl", () => {
  it("is off unless KEPT_NOTIFY_BLOCK_PRIVATE=true", async () => {
    expect(blockPrivateEnabled({})).toBe(false);
    expect(blockPrivateEnabled({ KEPT_NOTIFY_BLOCK_PRIVATE: "1" })).toBe(false);
    const lookup = vi.fn(resolvesTo("127.0.0.1"));
    await expect(
      assertAllowedUrl("http://localhost:8080", { env: {}, lookup }),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects hosts resolving to private addresses, including one among several", async () => {
    for (const addrs of [["10.0.0.4"], ["8.8.8.8", "192.168.0.2"], ["::1"]]) {
      await expect(
        assertAllowedUrl("https://ntfy.example.org", {
          env: on,
          lookup: resolvesTo(...addrs),
        }),
      ).rejects.toMatchObject({ code: "blocked_address" });
    }
  });

  it("allows hosts resolving only to public addresses", async () => {
    await expect(
      assertAllowedUrl("https://ntfy.example.org", {
        env: on,
        lookup: resolvesTo("8.8.8.8", "2001:db8::1"),
      }),
    ).resolves.toBeUndefined();
  });

  it("checks IPv6 literals without brackets and reports DNS failures", async () => {
    const lookup = vi.fn(resolvesTo("::1"));
    await expect(
      assertAllowedUrl("http://[::1]:8080/x", { env: on, lookup }),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(lookup).toHaveBeenCalledWith("::1", { all: true });
    await expect(
      assertAllowedUrl("https://nope.example.org", {
        env: on,
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ code: "dns" });
  });

  it("is enforced at send time and never reaches fetch when blocked", async () => {
    vi.stubEnv("KEPT_NOTIFY_BLOCK_PRIVATE", "true");
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const channel = ntfyChannel(
      { serverUrl: "http://127.0.0.1:8080", topic: "kept" },
      fetchFn,
    );
    await expect(channel.send({ title: "t", body: "b" })).rejects.toMatchObject(
      { code: "blocked_address" },
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
