import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_TOKEN_TTL_MS,
  consumeDownloadToken,
  issueDownloadToken,
} from "./admin-confirm";

describe("download tokens", () => {
  it("work once, for their user, within the ttl", () => {
    const t = issueDownloadToken("u1", 1000);
    expect(consumeDownloadToken(t, "u1", 1000 + 1)).toBe(true);
    expect(consumeDownloadToken(t, "u1", 1000 + 1)).toBe(false);
  });

  it("are refused for another user and burnt by the attempt", () => {
    const t = issueDownloadToken("u1", 1000);
    expect(consumeDownloadToken(t, "u2", 1001)).toBe(false);
    expect(consumeDownloadToken(t, "u1", 1001)).toBe(false);
  });

  it("expire", () => {
    const t = issueDownloadToken("u1", 1000);
    expect(consumeDownloadToken(t, "u1", 1000 + DOWNLOAD_TOKEN_TTL_MS)).toBe(
      false,
    );
  });

  it("reject missing and unknown tokens", () => {
    expect(consumeDownloadToken(null, "u1")).toBe(false);
    expect(consumeDownloadToken("nope", "u1")).toBe(false);
  });
});
