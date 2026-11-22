import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent } from "$lib/testing/event";
import { oauthCall } from "$lib/testing/oauth";
import { handle } from "../../hooks.server";
import { csrfRefusal, isCsrfForbidden } from "./csrf";

afterEach(() => vi.unstubAllEnvs());

function req(
  method: string,
  headers: Record<string, string> = {},
  path = "/settings/api-tokens?/create",
) {
  const url = new URL(`http://kept.test${path}`);
  return { request: new Request(url, { method, headers }), url };
}

describe("the form-post origin check", () => {
  it.each([
    // [method, headers, forbidden]
    ["POST", { "content-type": "application/x-www-form-urlencoded" }, true],
    ["POST", { "content-type": "multipart/form-data; boundary=x" }, true],
    ["POST", { "content-type": "text/plain" }, true],
    ["POST", { "content-type": "Application/X-WWW-Form-Urlencoded" }, true],
    ["POST", {}, true],
    ["PUT", {}, true],
    ["PATCH", { "content-type": "text/plain" }, true],
    ["DELETE", {}, true],
    ["POST", { "content-type": "application/json" }, false],
    ["POST", { "content-type": "application/octet-stream" }, false],
    ["GET", {}, false],
    ["HEAD", {}, false],
    ["OPTIONS", {}, false],
    [
      "POST",
      {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://kept.test",
      },
      false,
    ],
    [
      "POST",
      {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.example.org",
      },
      true,
    ],
    [
      "POST",
      {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://kept.test.evil.example.org",
      },
      true,
    ],
    ["POST", { origin: "null" }, true],
  ] as const)("%s %j is forbidden: %s", (method, headers, forbidden) => {
    const { request, url } = req(method, { ...headers });
    expect(isCsrfForbidden(request, url)).toBe(forbidden);
  });

  it("exempts exactly the OAuth client endpoints, nothing that reads a cookie", () => {
    const form = { "content-type": "application/x-www-form-urlencoded" };
    for (const path of ["/oauth/token", "/oauth/revoke", "/oauth/register"]) {
      const { request, url } = req("POST", form, path);
      expect(isCsrfForbidden(request, url), path).toBe(false);
    }
    for (const path of [
      "/oauth/authorize?/approve",
      "/oauth/authorize?/deny",
      "/oauth/token/x",
      "/oauth/tokens",
      "/login",
      "/settings/api-tokens?/revokeConnection",
      "/api/mcp/",
      "/api/mcp/x",
      "/api/mcpx",
      "/api/external/v1/bills",
      "/api/app/v1/pages/x",
    ]) {
      const { request, url } = req("POST", form, path);
      expect(isCsrfForbidden(request, url), path).toBe(true);
    }
  });

  it("lets a bodiless DELETE or POST reach the MCP gate, which ignores cookies", () => {
    for (const method of ["DELETE", "POST", "GET"]) {
      const { request, url } = req(method, {}, "/api/mcp");
      expect(isCsrfForbidden(request, url), method).toBe(false);
    }
  });

  it("answers 403 as JSON for a client that asks for it, else as text", async () => {
    const { request, url } = req("POST", { accept: "application/json" });
    const json = csrfRefusal(request, url)!;
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({
      message: "Cross-site POST form submissions are forbidden",
    });
    const plain = req("POST");
    expect(await csrfRefusal(plain.request, plain.url)!.text()).toContain(
      "forbidden",
    );
    const fine = req("POST", { origin: "http://kept.test" });
    expect(csrfRefusal(fine.request, fine.url)).toBeNull();
  });
});

describe("the handle hook applies it (as in a production build)", () => {
  useTestDB();

  const reached = async () => new Response("reached");

  async function send(
    path: string,
    init: { headers?: Record<string, string>; form?: Record<string, string> },
  ) {
    vi.stubEnv("DEV", false);
    const event = createTestEvent({
      url: `http://localhost${path}`,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...init.headers,
      },
      body: new URLSearchParams(init.form ?? {}).toString(),
    });
    return await handle({ event: event as never, resolve: reached as never });
  }

  it("refuses a cross-site form post to the consent action, before anything reads the session", async () => {
    for (const path of [
      "/oauth/authorize?/approve",
      "/oauth/authorize?/deny",
    ]) {
      const res = await send(path, {
        headers: { origin: "https://evil.example.org" },
      });
      expect(res.status, path).toBe(403);
      const noOrigin = await send(path, {});
      expect(noOrigin.status, path).toBe(403);
    }
  });

  it("lets the page's own origin through to the consent action", async () => {
    await createTestUser();
    const res = await send("/oauth/authorize?/approve", {
      headers: { origin: "http://localhost" },
    });
    // Past the origin check it is an ordinary page request without a session.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/login\?redirectTo=/);
  });

  it("lets a client with no Origin header call the token, revocation and registration endpoints", async () => {
    vi.stubEnv("DEV", false);
    const res = await oauthCall("/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: "keptrt_x",
        client_id: "c",
      },
    });
    // 401 invalid_client from the endpoint itself, not 403 from the origin check.
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
    const revoke = await oauthCall("/oauth/revoke", {
      form: { token: "x", client_id: "c" },
    });
    expect(revoke.status).toBe(200);
    const register = await oauthCall("/oauth/register", {
      json: { redirect_uris: [] },
    });
    expect(register.status).toBe(400);
  });

  it("answers a bodiless DELETE to /api/mcp from the gate (401, then 405), not the origin check", async () => {
    vi.stubEnv("DEV", false);
    const event = createTestEvent({
      url: "http://localhost/api/mcp",
      method: "DELETE",
    });
    const res = await handle({
      event: event as never,
      resolve: reached as never,
    });
    expect(res.status).toBe(401);
  });

  it("still refuses a cross-site form post carrying a session cookie to a normal form action", async () => {
    const res = await send("/settings/api-tokens?/create", {
      headers: {
        origin: "https://evil.example.org",
        cookie: "kept_session=x",
      },
      form: { name: "x" },
    });
    expect(res.status).toBe(403);
    const noOrigin = await send("/settings/api-tokens?/create", {
      headers: { cookie: "kept_session=x" },
    });
    expect(noOrigin.status).toBe(403);
  });

  it("does not make the exempt endpoints a way around the check for others", async () => {
    const res = await send("/settings/api-tokens?/revokeConnection", {
      headers: { origin: "https://evil.example.org" },
      form: { connectionId: "x" },
    });
    expect(res.status).toBe(403);
  });
});
