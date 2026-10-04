import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  PrivateNetworkError,
  assertHostAllowed,
  isPrivateAddress,
  isPrivateLiteralHost,
  privateNetworkAllowed,
  privateNetworkAllowedForUser,
  type Lookup,
} from "./private-network";

const resolvesTo =
  (...addresses: string[]): Lookup =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

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
    "::ffff:7f00:1",
    "::FFFF:7F00:0001",
    "0:0:0:0:0:ffff:7f00:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "0:0:0:0:0:0:0:0",
    "::127.0.0.1",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "::ffff:6440:1",
    "FE80:0:0:0:0:0:0:1",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "ff02::1",
    "fd00:ec2::254",
    "2002:7f00:1::",
    "2002:a00:1::1",
    "192.0.0.1",
    "192.0.0.170",
    "198.18.0.1",
    "198.19.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "fec0::1",
    "feff::1",
    "64:ff9b:1::1",
    "64:ff9b:1:ffff::8.8.8.8",
    "::ffff:0:808:808",
    "::ffff:0:8.8.8.8",
  ])("%s is private", (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each([
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "100.63.255.255",
    "100.128.0.1",
    "64:ff9b::808:808",
    "::ffff:808:808",
    "2606:4700::1111",
    "2002:808:808::1",
    "198.20.0.1",
    "192.0.1.1",
    "64:ff9b:2::1",
    "223.255.255.255",
  ])("%s is public", (a) => expect(isPrivateAddress(a)).toBe(false));
});

describe("privateNetworkAllowed", () => {
  it("defaults to administrators only", () => {
    expect(privateNetworkAllowed("admin", {})).toBe(true);
    expect(privateNetworkAllowed("member", {})).toBe(false);
  });

  it("KEPT_ALLOW_PRIVATE_NETWORK=true opens it for everyone", () => {
    const env = { KEPT_ALLOW_PRIVATE_NETWORK: "true" };
    expect(privateNetworkAllowed("member", env)).toBe(true);
    expect(privateNetworkAllowed("admin", env)).toBe(true);
    expect(
      privateNetworkAllowed("member", { KEPT_ALLOW_PRIVATE_NETWORK: "1" }),
    ).toBe(false);
  });

  it("KEPT_NOTIFY_BLOCK_PRIVATE=true blocks even administrators and wins", () => {
    const env = { KEPT_NOTIFY_BLOCK_PRIVATE: "true" };
    expect(privateNetworkAllowed("admin", env)).toBe(false);
    expect(
      privateNetworkAllowed("admin", {
        ...env,
        KEPT_ALLOW_PRIVATE_NETWORK: "true",
      }),
    ).toBe(false);
  });
});

describe("privateNetworkAllowedForUser", () => {
  useTestDB();

  it("follows the stored role and treats unknown users as members", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    expect(privateNetworkAllowedForUser(admin.id, {})).toBe(true);
    expect(privateNetworkAllowedForUser(member.id, {})).toBe(false);
    expect(privateNetworkAllowedForUser("missing", {})).toBe(false);
  });
});

describe("isPrivateLiteralHost", () => {
  it.each([
    "http://localhost:8000",
    "http://app.localhost/",
    "http://127.0.0.1/",
    "http://[::1]:8080/",
    "http://169.254.169.254/latest",
    "http://[::ffff:10.0.0.1]/",
    "http://[fd00:ec2::254]/",
  ])("%s is private", (u) => expect(isPrivateLiteralHost(u)).toBe(true));

  it.each(["https://example.org", "http://8.8.8.8/", "http://webserver:8000"])(
    "%s is not flagged without DNS",
    (u) => expect(isPrivateLiteralHost(u)).toBe(false),
  );
});

describe("assertHostAllowed", () => {
  it("lets everything through when private access is allowed, without a lookup", async () => {
    const lookup = vi.fn(resolvesTo("127.0.0.1"));
    await expect(
      assertHostAllowed("http://localhost:8080", {
        allowPrivate: true,
        lookup,
      }),
    ).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects literals and localhost without asking DNS", async () => {
    const lookup = vi.fn(resolvesTo("8.8.8.8"));
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://[::1]:8080/x",
      "http://169.254.169.254/latest/meta-data",
      "http://[::ffff:7f00:1]/",
    ]) {
      await expect(
        assertHostAllowed(url, { allowPrivate: false, lookup }),
      ).rejects.toMatchObject({ code: "blocked_address" });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects names resolving to private addresses, including one among several", async () => {
    for (const addrs of [
      ["10.0.0.4"],
      ["8.8.8.8", "192.168.0.2"],
      ["::1"],
      ["::ffff:169.254.169.254"],
    ]) {
      await expect(
        assertHostAllowed("https://ntfy.example.org", {
          allowPrivate: false,
          lookup: resolvesTo(...addrs),
        }),
      ).rejects.toBeInstanceOf(PrivateNetworkError);
    }
  });

  it("resolves on every call, so a changed answer is caught", async () => {
    let answer = "8.8.8.8";
    const lookup: Lookup = async () => [{ address: answer, family: 4 }];
    const url = "https://hooks.example.org/x";
    await expect(
      assertHostAllowed(url, { allowPrivate: false, lookup }),
    ).resolves.toBeUndefined();
    answer = "10.1.1.1";
    await expect(
      assertHostAllowed(url, { allowPrivate: false, lookup }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("allows public answers and reports DNS failures and empty answers", async () => {
    await expect(
      assertHostAllowed("https://ntfy.example.org", {
        allowPrivate: false,
        lookup: resolvesTo("8.8.8.8", "2606:4700::1111"),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertHostAllowed("https://nope.example.org", {
        allowPrivate: false,
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ code: "dns" });
    await expect(
      assertHostAllowed("https://empty.example.org", {
        allowPrivate: false,
        lookup: resolvesTo(),
      }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });
});
