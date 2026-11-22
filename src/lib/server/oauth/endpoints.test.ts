import { afterEach, describe, expect, it, vi } from "vitest";
import { getDB, oauthClients } from "$lib/server/db";
import { useTestDB } from "$lib/testing/db";
import { LOOPBACK, body, oauthCall } from "$lib/testing/oauth";
import {
  MAX_CLIENTS,
  OAUTH_MAX_BODY_BYTES,
  REGISTRATIONS_PER_HOUR,
} from "./config";
import {
  registrationLimiter,
  revocationLimiter,
  tokenFailureLimiter,
} from "./http";
import { SCOPES_SUPPORTED } from "./urls";

afterEach(() => {
  vi.unstubAllEnvs();
  registrationLimiter.reset();
  tokenFailureLimiter.reset();
  revocationLimiter.reset();
});

const PUBLIC_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
];

describe("metadata", () => {
  it("describes the protected resource, at both well-known forms", async () => {
    for (const path of PUBLIC_PATHS.slice(0, 2)) {
      const res = await oauthCall(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: "http://localhost/api/mcp",
        authorization_servers: ["http://localhost"],
        scopes_supported: [...SCOPES_SUPPORTED],
        bearer_methods_supported: ["header"],
        resource_name: "Kept",
      });
    }
  });

  it("describes the authorization server so a client can use it without knowing Kept", async () => {
    const meta = await body<Record<string, unknown>>(
      await oauthCall("/.well-known/oauth-authorization-server"),
    );
    expect(meta).toEqual({
      issuer: "http://localhost",
      authorization_endpoint: "http://localhost/oauth/authorize",
      token_endpoint: "http://localhost/oauth/token",
      registration_endpoint: "http://localhost/oauth/register",
      revocation_endpoint: "http://localhost/oauth/revoke",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...SCOPES_SUPPORTED],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("advertises only read permissions, so a client that asks for everything listed gets no write access", () => {
    expect(SCOPES_SUPPORTED.length).toBeGreaterThan(0);
    expect(SCOPES_SUPPORTED.some((s) => s.endsWith(":write"))).toBe(false);
    expect(SCOPES_SUPPORTED).not.toContain("changes:revert");
  });

  it("derives every URL from ORIGIN when it is set, else from the request", async () => {
    vi.stubEnv("ORIGIN", "https://kept.example.org");
    const meta = await body<Record<string, string>>(
      await oauthCall("/.well-known/oauth-authorization-server"),
    );
    expect(meta.issuer).toBe("https://kept.example.org");
    expect(meta.token_endpoint).toBe("https://kept.example.org/oauth/token");
    const resource = await body<Record<string, unknown>>(
      await oauthCall("/.well-known/oauth-protected-resource/api/mcp"),
    );
    expect(resource).toMatchObject({
      resource: "https://kept.example.org/api/mcp",
      authorization_servers: ["https://kept.example.org"],
    });
    vi.stubEnv("ORIGIN", "");
    const lan = await body<Record<string, string>>(
      await oauthCall("/.well-known/oauth-authorization-server", {
        base: "http://192.168.1.20:3000",
      }),
    );
    expect(lan.issuer).toBe("http://192.168.1.20:3000");
  });

  it("is public: no session, and no cookie is sent back", async () => {
    for (const path of PUBLIC_PATHS.slice(0, 3)) {
      const res = await oauthCall(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("CORS", () => {
  it("lets any origin read the metadata and the client endpoints, never with credentials", async () => {
    for (const path of PUBLIC_PATHS) {
      const res = await oauthCall(path, {
        method: path.startsWith("/oauth") ? "POST" : "GET",
        headers: { origin: "http://localhost:6274" },
        form: path.startsWith("/oauth") ? {} : undefined,
      });
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(
        res.headers.get("access-control-allow-credentials"),
        path,
      ).toBeNull();
    }
  });

  it("answers a preflight without needing a session or a body", async () => {
    for (const path of PUBLIC_PATHS) {
      const res = await oauthCall(path, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,authorization",
        },
      });
      expect(res.status, path).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain(
        "content-type",
      );
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("does not change who may call the MCP endpoint itself", async () => {
    const { originRefusal } = await import("$lib/server/mcp/gate");
    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { origin: "https://evil.example.org" },
    });
    expect(originRefusal(request)?.status).toBe(403);
  });
});

describe("registration endpoint", () => {
  useTestDB();

  const register = (json: unknown, ip = "198.51.100.1") =>
    oauthCall("/oauth/register", { json, ip });
  const valid = { client_name: "App", redirect_uris: [LOOPBACK] };

  it("registers a public client and returns what was stored, never a secret", async () => {
    const res = await register({
      ...valid,
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await body<Record<string, unknown>>(res);
    expect(out).toMatchObject({
      client_name: "App",
      redirect_uris: [LOOPBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(out.client_id).toEqual(expect.any(String));
    expect(out.client_secret).toBeUndefined();
    expect(await getDB().select().from(oauthClients)).toHaveLength(1);
  });

  it("answers errors in the RFC 7591 shape", async () => {
    const res = await register({
      client_name: "x",
      redirect_uris: ["javascript:alert(1)"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_redirect_uri",
      error_description: expect.any(String),
    });
    const secret = await register({
      ...valid,
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect((await body(secret)).error).toBe("invalid_client_metadata");
    expect(await getDB().select().from(oauthClients)).toHaveLength(0);
  });

  it("wants JSON, small and well-formed", async () => {
    const wrongType = await oauthCall("/oauth/register", {
      form: { redirect_uris: LOOPBACK },
    });
    expect(wrongType.status).toBe(400);
    const garbage = await oauthCall("/oauth/register", { json: "{not json" });
    expect(garbage.status).toBe(400);
    expect((await body(garbage)).error).toBe("invalid_client_metadata");
    const huge = await oauthCall("/oauth/register", {
      json: JSON.stringify({
        ...valid,
        client_name: "x".repeat(OAUTH_MAX_BODY_BYTES),
      }),
    });
    expect(huge.status).toBe(413);
    expect(await getDB().select().from(oauthClients)).toHaveLength(0);
  });

  it("limits registrations per address", async () => {
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) {
      expect((await register(valid, "198.51.100.5")).status).toBe(201);
    }
    const refused = await register(valid, "198.51.100.5");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    expect((await register(valid, "198.51.100.6")).status).toBe(201);
    expect(await getDB().select().from(oauthClients)).toHaveLength(
      REGISTRATIONS_PER_HOUR + 1,
    );
  });

  it("makes room at the cap on stored clients by dropping the oldest unconnected one", async () => {
    await getDB()
      .insert(oauthClients)
      .values(
        Array.from({ length: MAX_CLIENTS }, (_, i) => ({
          name: `c${i}`,
          redirectUris: [LOOPBACK],
        })),
      );
    const res = await register(valid);
    expect(res.status).toBe(201);
    expect(await getDB().select().from(oauthClients)).toHaveLength(MAX_CLIENTS);
  });
});

describe("token and revocation endpoints: request shape", () => {
  useTestDB();

  it("takes form-encoded bodies only", async () => {
    const json = await oauthCall("/oauth/token", {
      json: { grant_type: "refresh_token" },
    });
    expect(json.status).toBe(400);
    expect((await body(json)).error).toBe("invalid_request");
    const revoke = await oauthCall("/oauth/revoke", { json: { token: "x" } });
    expect(revoke.status).toBe(400);
  });

  it("names what is wrong without echoing the request", async () => {
    const cases: [Record<string, string>, string][] = [
      [{}, "invalid_request"],
      [
        { grant_type: "password", username: "a", password: "b" },
        "unsupported_grant_type",
      ],
      [{ grant_type: "client_credentials" }, "unsupported_grant_type"],
      [{ grant_type: "authorization_code" }, "invalid_request"],
      [{ grant_type: "refresh_token", client_id: "c" }, "invalid_request"],
    ];
    for (const [form, error] of cases) {
      const res = await oauthCall("/oauth/token", { form });
      expect(res.status, JSON.stringify(form)).toBe(400);
      expect(await res.json()).toEqual({
        error,
        error_description: expect.any(String),
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("refuses a repeated parameter and an oversized body", async () => {
    const res = await oauthCall("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      json: "grant_type=refresh_token&refresh_token=a&refresh_token=b&client_id=c",
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("invalid_request");
    const big = await oauthCall("/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: "x".repeat(OAUTH_MAX_BODY_BYTES),
        client_id: "c",
      },
    });
    expect(big.status).toBe(413);
  });

  it("asks revocation for a token and a client", async () => {
    const res = await oauthCall("/oauth/revoke", { form: { token: "x" } });
    expect(res.status).toBe(400);
    const ok = await oauthCall("/oauth/revoke", {
      form: { token: "x", client_id: "unknown" },
    });
    expect(ok.status).toBe(200);
  });
});
