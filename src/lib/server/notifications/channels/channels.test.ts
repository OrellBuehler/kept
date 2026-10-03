import type { FetchFn } from "./http";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { signBody } from "../sign";
import type { SmtpConfig } from "../smtp";
import { ChannelError } from "../types";
import { emailChannel } from "./email";
import { normalizeUrl } from "./http";
import { ntfyChannel } from "./ntfy";
import { SIGNATURE_HEADER, webhookChannel } from "./webhook";

const message = { title: "Bill overdue", body: "Example Supplier: 125.50" };

const mockFetch = (status = 200) =>
  vi.fn<FetchFn>(async () => new Response(null, { status }));

const call = (f: ReturnType<typeof mockFetch>) => {
  const [url, init] = f.mock.calls[0]!;
  return {
    url: String(url),
    init: init!,
    headers: init!.headers as Record<string, string>,
    json: JSON.parse(String(init!.body)),
  };
};

describe("signBody", () => {
  it("is the hex HMAC-SHA256 of the body", () => {
    const expected = createHmac("sha256", "s3cret").update("{}").digest("hex");
    expect(signBody("s3cret", "{}")).toBe(`sha256=${expected}`);
    expect(signBody("other", "{}")).not.toBe(signBody("s3cret", "{}"));
  });
});

describe("ntfy", () => {
  it("publishes JSON to the server root with an optional bearer token", async () => {
    const f = mockFetch();
    await ntfyChannel(
      { serverUrl: "https://ntfy.example.org", topic: "kept", token: "tk_x" },
      f,
    ).send(message);
    const c = call(f);
    expect(c.url).toBe("https://ntfy.example.org");
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("manual");
    expect(c.headers.authorization).toBe("Bearer tk_x");
    expect(c.json).toEqual({
      topic: "kept",
      title: message.title,
      message: message.body,
    });
  });

  it("sends no authorization header without a token", async () => {
    const f = mockFetch();
    await ntfyChannel(
      { serverUrl: "https://ntfy.example.org", topic: "kept" },
      f,
    ).send(message);
    expect(call(f).headers.authorization).toBeUndefined();
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "http"],
    [302, "redirect"],
  ])("status %i becomes %s", async (status, code) => {
    const channel = ntfyChannel(
      { serverUrl: "https://ntfy.example.org", topic: "kept" },
      mockFetch(status),
    );
    await expect(channel.send(message)).rejects.toMatchObject({ code });
  });

  it("maps network failures and timeouts without leaking content", async () => {
    const net = ntfyChannel(
      { serverUrl: "https://ntfy.example.org", topic: "kept" },
      vi.fn<FetchFn>(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(net.send(message)).rejects.toMatchObject({ code: "network" });
    const slow = ntfyChannel(
      { serverUrl: "https://ntfy.example.org", topic: "kept" },
      vi.fn<FetchFn>(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    await expect(slow.send(message)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("webhook", () => {
  const now = () => new Date("2026-10-03T08:00:00.000Z");

  it("signs the exact body when a secret is set", async () => {
    const f = mockFetch();
    await webhookChannel(
      { url: "https://hooks.example.org/k", secret: "s3cret" },
      f,
      now,
    ).send(message);
    const c = call(f);
    expect(c.json).toEqual({
      source: "kept",
      title: message.title,
      message: message.body,
      sentAt: "2026-10-03T08:00:00.000Z",
    });
    expect(c.headers[SIGNATURE_HEADER]).toBe(
      signBody("s3cret", String(c.init.body)),
    );
  });

  it("omits the signature without a secret", async () => {
    const f = mockFetch();
    await webhookChannel({ url: "https://hooks.example.org/k" }, f, now).send(
      message,
    );
    expect(call(f).headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("fails on a non-2xx answer", async () => {
    const channel = webhookChannel(
      { url: "https://hooks.example.org/k" },
      mockFetch(404),
      now,
    );
    const err = await channel.send(message).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.reason).toContain("404");
  });
});

describe("email", () => {
  const smtp: SmtpConfig = {
    host: "smtp.example.org",
    port: 587,
    secure: false,
    user: null,
    password: null,
    from: "kept@example.org",
  };

  it("sends plain text from the configured sender", async () => {
    const sendMail = vi.fn(async () => ({}));
    await emailChannel({ to: "me@example.org" }, smtp, sendMail).send(message);
    expect(sendMail).toHaveBeenCalledWith({
      from: "kept@example.org",
      to: "me@example.org",
      subject: message.title,
      text: message.body,
    });
  });

  it("maps SMTP errors to short reasons", async () => {
    const auth = emailChannel({ to: "me@example.org" }, smtp, async () => {
      throw Object.assign(new Error("535 secret details"), { code: "EAUTH" });
    });
    const err = await auth.send(message).catch((e) => e);
    expect(err).toMatchObject({ code: "smtp_auth" });
    expect(err.reason).not.toContain("secret details");
  });
});

describe("normalizeUrl", () => {
  it("accepts http(s) and rejects everything else", () => {
    expect(normalizeUrl(" https://ntfy.example.org/ ")).toBe(
      "https://ntfy.example.org",
    );
    expect(normalizeUrl("ftp://x.example.org")).toBeNull();
    expect(normalizeUrl("https://user:pw@x.example.org")).toBeNull();
    expect(normalizeUrl("nonsense")).toBeNull();
  });
});
