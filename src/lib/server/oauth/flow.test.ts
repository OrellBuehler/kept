import { afterEach, describe, expect, it } from "vitest";
import { listChanges } from "$lib/server/audit/list";
import { apiAuthFailureLimiter } from "$lib/server/external-api/gate";
import { mcpTokenLimiter } from "$lib/server/mcp/gate";
import { useTestDB } from "$lib/testing/db";
import { callMcp, callTool, initialize, rpc } from "$lib/testing/mcp";
import { buildWorld } from "$lib/testing/mcp-world";
import {
  BASE,
  LOOPBACK,
  authorizeLoad,
  authorizeQuery,
  body,
  consentAction,
  oauthCall,
  parseRedirect,
  pkce,
  registerTestClient,
} from "$lib/testing/oauth";
import {
  registrationLimiter,
  revocationLimiter,
  tokenFailureLimiter,
} from "./http";

afterEach(() => {
  mcpTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
  tokenFailureLimiter.reset();
  registrationLimiter.reset();
  revocationLimiter.reset();
});

describe("oauth: a client connects, works and is revoked", () => {
  useTestDB();

  it("goes from the 401 challenge to a revoked connection", async () => {
    const w = await buildWorld();

    // Discovery starts at the challenge of the MCP endpoint.
    const unauthenticated = await callMcp(null, {
      body: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(unauthenticated.status).toBe(401);
    const challenge = unauthenticated.headers.get("www-authenticate")!;
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1]!;
    const resourceMeta = await body<{
      resource: string;
      authorization_servers: string[];
    }>(await oauthCall(new URL(metadataUrl).pathname));
    expect(resourceMeta.resource).toBe(`${BASE}/api/mcp`);
    expect(resourceMeta.authorization_servers).toEqual([BASE]);

    // The authorization server it names describes itself.
    const meta = await body<Record<string, unknown>>(
      await oauthCall("/.well-known/oauth-authorization-server"),
    );
    expect(meta).toMatchObject({
      issuer: BASE,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    const path = (key: string) => new URL(meta[key] as string).pathname;

    // Dynamic registration of a public client.
    const registered = await registerTestClient({}, {});
    expect(registered.res.status).toBe(201);
    const clientId = registered.clientId;

    // Authorization: the owner is signed in; the request is stored, then consented to.
    const { verifier, challenge: codeChallenge } = pkce();
    const begun = await authorizeLoad(
      w.a,
      authorizeQuery({
        clientId,
        challenge: codeChallenge,
        state: "opaque state ~ 1",
        scope: "transactions:read transactions:write categories:read",
      }),
    );
    expect(begun.type).toBe("redirect");
    const consent = new URL(
      (begun as { location: string }).location,
      BASE,
    ).searchParams.get("consent")!;

    // Writing needs the owner's password.
    const unconfirmed = await consentAction("approve", w.a, consent, {
      scope: ["transactions:read", "transactions:write", "categories:read"],
    });
    expect(unconfirmed.type).toBe("fail");
    const approved = await consentAction("approve", w.a, consent, {
      scope: ["transactions:read", "transactions:write", "categories:read"],
      adminPassword: w.a.password,
    });
    expect(approved.type).toBe("return");
    const back = parseRedirect(
      (approved as { value: { redirectTo: string } }).value.redirectTo,
    );
    expect(back.origin + back.pathname).toBe(LOOPBACK);
    expect(back.searchParams.get("state")).toBe("opaque state ~ 1");
    expect(back.searchParams.get("iss")).toBe(BASE);
    const code = back.searchParams.get("code")!;

    // The code becomes tokens.
    const tokenRes = await oauthCall(path("token_endpoint"), {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: LOOPBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: resourceMeta.resource,
      },
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokens = await body<{
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>(tokenRes);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope.split(" ").sort()).toEqual([
      "categories:read",
      "transactions:read",
      "transactions:write",
    ]);

    // The MCP endpoint accepts the access token.
    expect((await initialize(tokens.access_token)).status).toBe(200);
    const tools = (
      (await rpc(tokens.access_token, "tools/list", {})).json.result!.tools as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tools).toContain("update_transaction");
    expect(tools).not.toContain("list_bills");

    // A write is attributed to the connection in the change log.
    const wrote = await callTool(tokens.access_token, "update_transaction", {
      paymentId: w.t4.id,
      note: "set through oauth",
    });
    expect(wrote.isError).toBe(false);
    const [entry] = (await listChanges(w.a.id)).items;
    expect(entry).toMatchObject({
      actor: { kind: "mcp", label: "Test Client" },
    });
    const connectionId = entry!.actor.tokenId!;

    // Refreshing keeps the connection (and so the attribution).
    const refreshed = await body<{
      access_token: string;
      refresh_token: string;
    }>(
      await oauthCall(path("token_endpoint"), {
        form: {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: clientId,
        },
      }),
    );
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    await callTool(refreshed.access_token, "update_transaction", {
      paymentId: w.t5.id,
      note: "after refresh",
    });
    const [second] = (await listChanges(w.a.id)).items;
    expect(second!.actor.tokenId).toBe(connectionId);

    // Revoking the connection ends everything it issued.
    const revoked = await oauthCall(path("revocation_endpoint"), {
      form: { token: refreshed.refresh_token, client_id: clientId },
    });
    expect(revoked.status).toBe(200);
    for (const token of [tokens.access_token, refreshed.access_token]) {
      const res = await initialize(token);
      expect(res.status).toBe(401);
    }
    const denied = await callMcp(refreshed.access_token, {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(denied.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });
});
