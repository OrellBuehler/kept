import { describe, expect, it } from "vitest";
import {
  checkRedirectUri,
  describeRedirectUri,
  matchRedirectUri,
} from "./redirect-uri";

describe("redirect URIs: what may be registered", () => {
  it.each([
    "https://client.example.org/callback",
    "https://client.example.org:8443/cb?x=1",
    "http://127.0.0.1:53682/callback",
    "http://127.0.0.1/callback",
    "http://[::1]:8080/cb",
    "http://localhost:6274/oauth/callback",
  ])("accepts %s", (uri) => {
    expect(checkRedirectUri(uri).ok).toBe(true);
  });

  it.each([
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,<script>alert(1)</script>", "scheme"],
    ["vbscript:msgbox(1)", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["myapp://callback", "private-use schemes are not accepted"],
    ["ftp://client.example.org/cb", "scheme"],
    ["http://client.example.org/callback", "plain http to another host"],
    ["http://192.168.1.20:8080/cb", "plain http to a LAN host"],
    [
      "http://localhost.example.org/cb",
      "a name that merely starts with localhost",
    ],
    [
      "http://127.0.0.1.example.org/cb",
      "a name that merely starts with 127.0.0.1",
    ],
    ["https://client.example.org/cb#frag", "fragment"],
    ["https://user:pw@client.example.org/cb", "credentials"],
    ["/relative/path", "relative"],
    ["", "empty"],
    ["https://client.example.org/a b", "space"],
    ["https://client.example.org/a\\b", "backslash"],
    [`https://client.example.org/${"a".repeat(600)}`, "too long"],
  ])("refuses %s (%s)", (uri) => {
    expect(checkRedirectUri(uri).ok).toBe(false);
  });

  it("normalises numeric spellings of loopback before judging them", () => {
    // The URL parser turns 127.1 into 127.0.0.1: judged as what a browser would visit.
    expect(checkRedirectUri("http://127.1/cb").ok).toBe(true);
    expect(checkRedirectUri("http://2130706433/cb").ok).toBe(true);
    expect(checkRedirectUri("http://0.0.0.0/cb").ok).toBe(false);
  });
});

describe("redirect URIs: matching a request to a registration", () => {
  it("needs an exact match for https", () => {
    const registered = ["https://client.example.org/callback"];
    expect(matchRedirectUri(registered, registered[0]!)).toBe(true);
    for (const other of [
      "https://client.example.org/callback/",
      "https://client.example.org/callback?x=1",
      "https://client.example.org/other",
      "https://client.example.org:8443/callback",
      "https://evil.example.org/callback",
      "https://client.example.org.evil.example/callback",
      "http://client.example.org/callback",
    ]) {
      expect(matchRedirectUri(registered, other), other).toBe(false);
    }
  });

  it("lets a loopback URI use another port, and nothing else differ", () => {
    const registered = ["http://127.0.0.1:53682/callback"];
    expect(
      matchRedirectUri(registered, "http://127.0.0.1:41000/callback"),
    ).toBe(true);
    expect(matchRedirectUri(registered, "http://127.0.0.1/callback")).toBe(
      true,
    );
    for (const other of [
      "http://127.0.0.1:41000/other",
      "http://127.0.0.1:41000/callback?x=1",
      "http://localhost:41000/callback",
      "http://[::1]:41000/callback",
      "https://127.0.0.1:41000/callback",
    ]) {
      expect(matchRedirectUri(registered, other), other).toBe(false);
    }
  });

  it("does not turn a registered https URI into a port wildcard", () => {
    expect(
      matchRedirectUri(
        ["https://client.example.org/cb"],
        "https://client.example.org:9999/cb",
      ),
    ).toBe(false);
  });

  it("never matches a requested URI that could not be registered", () => {
    expect(
      matchRedirectUri(["http://127.0.0.1/cb"], "javascript:alert(1)"),
    ).toBe(false);
  });

  it("describes where the owner is sent", () => {
    expect(describeRedirectUri("http://localhost:6274/cb")).toEqual({
      host: "localhost:6274",
      loopback: true,
    });
    expect(describeRedirectUri("https://client.example.org/cb")).toEqual({
      host: "client.example.org",
      loopback: false,
    });
  });
});
