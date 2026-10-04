import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelError } from "../types";
import { assertAllowedUrl, type Lookup } from "./guard";
import { ntfyChannel } from "./ntfy";
import { webhookChannel } from "./webhook";

const resolvesTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

afterEach(() => vi.unstubAllEnvs());

describe("assertAllowedUrl", () => {
  it("converts private destinations and DNS failures into channel errors", async () => {
    await expect(
      assertAllowedUrl("https://ntfy.example.org", {
        allowPrivate: false,
        lookup: resolvesTo("10.0.0.4"),
      }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    await expect(
      assertAllowedUrl("http://[::1]:8080/x", { allowPrivate: false }),
    ).rejects.toBeInstanceOf(ChannelError);
    await expect(
      assertAllowedUrl("https://nope.example.org", {
        allowPrivate: false,
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ code: "dns" });
  });

  it("allows private destinations when told to", async () => {
    await expect(
      assertAllowedUrl("http://127.0.0.1:8080", { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it("is enforced at send time for ntfy and webhooks and never reaches fetch when blocked", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const ntfy = ntfyChannel(
      { serverUrl: "http://127.0.0.1:8080", topic: "kept" },
      fetchFn,
    );
    const hook = webhookChannel({ url: "http://10.0.0.5/hook" }, fetchFn);
    for (const channel of [ntfy, hook]) {
      await expect(
        channel.send({ title: "t", body: "b" }),
      ).rejects.toMatchObject({ code: "blocked_address" });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends to a private host when the channel was built with permission", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const ntfy = ntfyChannel(
      { serverUrl: "http://127.0.0.1:8080", topic: "kept" },
      fetchFn,
      true,
    );
    await ntfy.send({ title: "t", body: "b" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
