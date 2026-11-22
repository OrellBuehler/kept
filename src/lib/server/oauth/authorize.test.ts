import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { apiTokenConfirmLimiter } from "$lib/server/auth/rate-limit";
import { createCategory } from "$lib/server/categories";
import { getDB, mcpConnections, oauthAuthorizations } from "$lib/server/db";
import { createTestUser, enableTotp, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedAccount } from "$lib/testing/ledger";
import {
  BASE,
  LOOPBACK,
  authorizeLoad,
  authorizeQuery,
  consentAction,
  oauthCall,
  parseRedirect,
  pkce,
  registerTestClient,
  type AuthorizeParams,
} from "$lib/testing/oauth";
import { beginAuthorization, loadPendingConsent } from "./authorize";
import {
  CODE_TTL_MS,
  MAX_ACTIVE_CONNECTIONS,
  MAX_PENDING_REQUESTS_PER_USER,
  PENDING_REQUEST_TTL_MS,
} from "./config";
import { DEFAULT_SCOPES } from "./scopes";

useTestDB();

afterEach(() => apiTokenConfirmLimiter.reset());

async function client(over: Record<string, unknown> = {}) {
  return (await registerTestClient(over)).clientId;
}

async function start(
  user: TestUser,
  clientId: string,
  over: Partial<AuthorizeParams> = {},
) {
  const { verifier, challenge } = pkce();
  const result = await authorizeLoad(
    user,
    authorizeQuery({ clientId, challenge, ...over }),
  );
  return { verifier, challenge, result };
}

async function consentId(
  user: TestUser,
  clientId: string,
  over: Partial<AuthorizeParams> = {},
) {
  const { result, verifier, challenge } = await start(user, clientId, over);
  if (result.type !== "redirect") throw new Error("not started");
  return {
    id: new URL(result.location, BASE).searchParams.get("consent")!,
    verifier,
    challenge,
  };
}

/** What a started request answered: an error page, a redirect to the client, or the consent page. */
function kind(result: Awaited<ReturnType<typeof start>>["result"]) {
  if (result.type === "error") return `page:${result.status}`;
  if (result.type !== "redirect") return result.type;
  return result.location.startsWith(`${BASE}/oauth/authorize?consent=`) ||
    result.location.startsWith("/oauth/authorize?consent=")
    ? "consent"
    : "client";
}

describe("authorization request: client and redirect URI are checked first", () => {
  it("shows an error page, and redirects nowhere, for an unknown client", async () => {
    const user = await createTestUser();
    const { result } = await start(user, "no-such-client");
    expect(result).toEqual({ type: "error", status: 400 });
  });

  it("shows an error page for a client id that is missing or repeated", async () => {
    const user = await createTestUser();
    const id = await client();
    const { challenge } = pkce();
    const q = authorizeQuery({ clientId: id, challenge });
    q.append("client_id", "another");
    expect((await authorizeLoad(user, q)).type).toBe("error");
    expect((await authorizeLoad(user, "response_type=code")).type).toBe(
      "error",
    );
  });

  it("shows an error page, never a redirect, for a redirect URI that was not registered", async () => {
    const user = await createTestUser();
    const id = await client();
    for (const redirectUri of [
      "https://evil.example.org/callback",
      "http://127.0.0.1:53682/other",
      "http://localhost:53682/callback",
      "javascript:alert(1)",
      "//evil.example.org",
      "",
    ]) {
      const { result } = await start(user, id, { redirectUri });
      expect(kind(result), redirectUri).toBe("page:400");
    }
  });

  it("accepts a loopback redirect URI on another port than registered", async () => {
    const user = await createTestUser();
    const id = await client();
    const { result } = await start(user, id, {
      redirectUri: "http://127.0.0.1:60001/callback",
    });
    expect(kind(result)).toBe("consent");
  });

  it("falls back to the one registered redirect URI when none is sent, but not to one of several", async () => {
    const user = await createTestUser();
    const one = await client({
      redirect_uris: ["https://client.example.org/cb"],
    });
    expect(kind((await start(user, one, { redirectUri: null })).result)).toBe(
      "consent",
    );
    const two = await client({
      redirect_uris: ["https://a.example.org/cb", "https://b.example.org/cb"],
    });
    expect(kind((await start(user, two, { redirectUri: null })).result)).toBe(
      "page:400",
    );
  });
});

describe("authorization request: other problems go back to the client", () => {
  async function failure(over: Partial<AuthorizeParams>, state = "s-1") {
    const user = await createTestUser();
    const id = await client();
    const { result } = await start(user, id, { state, ...over });
    expect(result.type).toBe("redirect");
    const url = parseRedirect((result as { location: string }).location);
    expect(url.origin + url.pathname).toBe(LOOPBACK);
    return url.searchParams;
  }

  it("requires PKCE with S256", async () => {
    const noMethod = await failure({ method: null });
    expect(noMethod.get("error")).toBe("invalid_request");
    const plain = await failure({ method: "plain" });
    expect(plain.get("error")).toBe("invalid_request");
    const badChallenge = await failure({ challenge: "short" });
    expect(badChallenge.get("error")).toBe("invalid_request");
  });

  it("passes state through unchanged and names the issuer, also in errors", async () => {
    const odd = "a b+c/d=e&f%20gé";
    const q = await failure({ responseType: "token", state: odd });
    expect(q.get("error")).toBe("unsupported_response_type");
    expect(q.get("state")).toBe(odd);
    expect(q.get("iss")).toBe(BASE);
  });

  it("refuses a resource that is not the MCP endpoint, and accepts its spellings", async () => {
    for (const resource of [
      "https://evil.example.org/api/mcp",
      `${BASE}/api/external/v1`,
      `${BASE}/api/mcp?x=1`,
      `${BASE}/api/mcp#x`,
      "not a url",
    ]) {
      const q = await failure({ resource });
      expect(q.get("error"), resource).toBe("invalid_target");
    }
    const user = await createTestUser();
    const id = await client();
    for (const resource of [`${BASE}/api/mcp`, `${BASE}/api/mcp/`, null]) {
      expect(
        kind((await start(user, id, { resource })).result),
        String(resource),
      ).toBe("consent");
    }
  });

  it("shows an error page instead of redirecting when the registered address is not loopback", async () => {
    const user = await createTestUser();
    const redirectUri = "https://client.example.org/cb";
    const id = await client({ redirect_uris: [redirectUri] });
    for (const over of [
      { method: null },
      { responseType: "token" },
      { state: "x".repeat(2000) },
      { resource: "https://evil.example.org/api/mcp" },
      { challenge: "short" },
    ] as Partial<AuthorizeParams>[]) {
      const { result } = await start(user, id, { redirectUri, ...over });
      expect(kind(result), JSON.stringify(over)).toBe("page:400");
    }
    expect(kind((await start(user, id, { redirectUri })).result)).toBe(
      "consent",
    );
  });

  it("refuses an over-long state without echoing it", async () => {
    const q = await failure({ state: "x".repeat(2000) });
    expect(q.get("error")).toBe("invalid_request");
    expect(q.has("state")).toBe(false);
  });
});

describe("the consent page", () => {
  it("shows the client and where it sends the owner, with read access ticked when nothing was asked for", async () => {
    const user = await createTestUser();
    const id = await client({ client_name: "Editor" });
    const { id: consent } = await consentId(user, id);
    const pending = await loadPendingConsent(user.id, consent);
    expect(pending).toMatchObject({
      clientName: "Editor",
      redirectUri: LOOPBACK,
      redirectIsLoopback: true,
      askedForScopes: false,
    });
    expect(pending!.scopes).toEqual([...DEFAULT_SCOPES]);
    expect(pending!.scopes.some((s) => s.endsWith(":write"))).toBe(false);
  });

  it("ticks what the client asked for, ignoring names it does not know", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id, {
      scope: "bills:read offline_access mcp:access bills:write links:write",
    });
    const pending = await loadPendingConsent(user.id, consent);
    expect(pending!.scopes).toEqual(["bills:read", "bills:write"]);
    expect(pending!.askedForScopes).toBe(true);
  });

  it("warns when the owner is sent to another host", async () => {
    const user = await createTestUser();
    const id = await client({
      redirect_uris: ["https://client.example.org/cb"],
    });
    const { id: consent } = await consentId(user, id, {
      redirectUri: "https://client.example.org/cb",
    });
    expect(await loadPendingConsent(user.id, consent)).toMatchObject({
      redirectHost: "client.example.org",
      redirectIsLoopback: false,
    });
  });

  it("is gone after its time, and keeps at most a few pending requests per user", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id);
    expect(
      await loadPendingConsent(
        user.id,
        consent,
        Date.now() + PENDING_REQUEST_TTL_MS + 1000,
      ),
    ).toBeNull();

    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_REQUESTS_PER_USER + 3; i++) {
      ids.push((await consentId(user, id)).id);
    }
    const rows = await getDB()
      .select()
      .from(oauthAuthorizations)
      .where(eq(oauthAuthorizations.userId, user.id));
    expect(rows).toHaveLength(MAX_PENDING_REQUESTS_PER_USER);
    expect(await loadPendingConsent(user.id, ids[0]!)).toBeNull();
    expect(await loadPendingConsent(user.id, ids.at(-1)!)).not.toBeNull();
  });

  it("belongs to the user who started it", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(owner, id);
    expect(await loadPendingConsent(other.id, consent)).toBeNull();
    const load = await authorizeLoad(other, `consent=${consent}`);
    expect(load).toEqual({ type: "error", status: 400 });
    const approve = await consentAction("approve", other, consent, {
      scope: ["bills:read"],
    });
    expect(approve.type).toBe("fail");
    const deny = await consentAction("deny", other, consent);
    expect(deny.type).toBe("fail");
    // None of that used up the owner's request.
    const mine = await consentAction("approve", owner, consent, {
      scope: ["bills:read"],
    });
    expect(mine.type).toBe("return");
  });

  it("needs a session", async () => {
    const id = await client();
    const q = authorizeQuery({ clientId: id, challenge: pkce().challenge });
    expect(await authorizeLoad(null, q)).toEqual({
      type: "error",
      status: 401,
    });
    expect(await consentAction("approve", null, "x")).toEqual({
      type: "error",
      status: 401,
    });
    expect(await consentAction("deny", null, "x")).toEqual({
      type: "error",
      status: 401,
    });
  });

  it("is not a valid page without a stored request", async () => {
    const user = await createTestUser();
    expect(await authorizeLoad(user, "")).toEqual({
      type: "error",
      status: 400,
    });
    expect(await authorizeLoad(user, "consent=nope")).toEqual({
      type: "error",
      status: 400,
    });
  });
});

describe("approving", () => {
  const redeem = async (
    code: string,
    clientId: string,
    verifier: string,
    redirectUri = LOOPBACK,
  ) =>
    oauthCall("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
    });

  it("lets a plain form post (no JavaScript) finish: the action carries the redirect and the page after it is not an error", async () => {
    const user = await createTestUser();
    const id = await client({ client_name: "Editor" });
    const { id: consent } = await consentId(user, id);
    const out = await consentAction("approve", user, consent, {
      scope: ["bills:read"],
    });
    expect(out.type).toBe("return");
    const value = (out as { value: { redirectTo: string; clientName: string } })
      .value;
    expect(value.redirectTo.startsWith(LOOPBACK)).toBe(true);
    expect(value.clientName).toBe("Editor");
    // The load that follows the action in the same request: the request is spent.
    const after = await authorizeLoad(
      user,
      `consent=${encodeURIComponent(consent)}`,
      "POST",
    );
    expect(after.type).toBe("return");
    expect((after as { value: { consent: unknown } }).value.consent).toBeNull();
    // A fresh visit of the spent link is still the error page.
    const revisit = await authorizeLoad(
      user,
      `consent=${encodeURIComponent(consent)}`,
    );
    expect(revisit).toMatchObject({ type: "error", status: 400 });
  });

  it("redirects to the registered address with a code, the state and the issuer", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id, { state: "xyz" });
    const out = await consentAction("approve", user, consent, {
      scope: ["bills:read"],
    });
    const url = parseRedirect(
      (out as { value: { redirectTo: string } }).value.redirectTo,
    );
    expect(url.origin + url.pathname).toBe(LOOPBACK);
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("iss")).toBe(BASE);
    expect(url.searchParams.get("code")).toMatch(/^keptac_/);
  });

  it("uses the stored request, not what the form says: a tampered client, redirect, challenge or resource changes nothing", async () => {
    const user = await createTestUser();
    const id = await client();
    const other = await client({ client_name: "Attacker" });
    const { id: consent, verifier } = await consentId(user, id);
    const out = await consentAction("approve", user, consent, {
      scope: ["bills:read"],
      client_id: other,
      redirect_uri: "https://evil.example.org/callback",
      code_challenge: pkce().challenge,
      resource: "https://evil.example.org/api/mcp",
      state: "forged",
    });
    const url = parseRedirect(
      (out as { value: { redirectTo: string } }).value.redirectTo,
    );
    expect(url.origin + url.pathname).toBe(LOOPBACK);
    expect(url.searchParams.get("state")).toBeNull();
    const code = url.searchParams.get("code")!;
    // Only the original client with the original verifier redeems it.
    expect((await redeem(code, other, verifier)).status).toBe(400);
  });

  it("grants what was ticked, not what was asked for", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent, verifier } = await consentId(user, id, {
      scope: "bills:read transactions:read",
    });
    const out = await consentAction("approve", user, consent, {
      scope: ["accounts:read"],
    });
    const code = parseRedirect(
      (out as { value: { redirectTo: string } }).value.redirectTo,
    ).searchParams.get("code")!;
    const res = await redeem(code, id, verifier);
    expect((await res.json()).scope).toBe("accounts:read");
  });

  it("applies the token form's rules: at least one permission, known ones only, no REST-only permission", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id);
    for (const scope of [[], ["bills:delete"], ["links:write"]]) {
      const out = await consentAction("approve", user, consent, { scope });
      expect(out.type, JSON.stringify(scope)).toBe("fail");
    }
    // The request survived those refusals.
    expect(await loadPendingConsent(user.id, consent)).not.toBeNull();
  });

  it("refuses a permission that cannot honour a restriction, like the token form", async () => {
    const user = await createTestUser();
    const account = await seedAccount(user.id, { name: "Checking" });
    const id = await client();
    const { id: consent } = await consentId(user, id);
    const out = await consentAction("approve", user, consent, {
      scope: ["budgets:read"],
      restrictAccounts: "on",
      accountId: [account.id],
    });
    expect(out).toMatchObject({ type: "fail", status: 400 });
    expect(JSON.stringify((out as { data: unknown }).data)).toContain(
      "limited to accounts",
    );
  });

  it("stores the owner's restrictions and expiry, and only for the owner's own accounts and categories", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const mine = await seedAccount(user.id, { name: "Mine" });
    const theirs = await seedAccount(other.id, { name: "Theirs" });
    const cat = await createCategory(user.id, {
      name: "Food",
      kind: "expense",
      parentId: null,
      color: null,
      icon: null,
    });
    const id = await client();
    const first = await consentId(user, id);
    const foreign = await consentAction("approve", user, first.id, {
      scope: ["transactions:read"],
      restrictAccounts: "on",
      accountId: [theirs.id],
    });
    expect(foreign.type).toBe("fail");
    const bad = await consentAction("approve", user, first.id, {
      scope: ["transactions:read"],
      restrict: "on",
      categoryId: ["nope"],
    });
    expect(bad.type).toBe("fail");
    const past = await consentAction("approve", user, first.id, {
      scope: ["transactions:read"],
      expires: "2001-01-01",
    });
    expect(past.type).toBe("fail");
    const ok = await consentAction("approve", user, first.id, {
      scope: ["transactions:read"],
      restrictAccounts: "on",
      accountId: [mine.id],
      restrict: "on",
      categoryId: [cat.id],
      expires: "2999-01-01",
    });
    // The date is beyond the five year limit.
    expect(ok.type).toBe("fail");
    const year = new Date(Date.now() + 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const fine = await consentAction("approve", user, first.id, {
      scope: ["transactions:read"],
      restrictAccounts: "on",
      accountId: [mine.id],
      restrict: "on",
      categoryId: [cat.id],
      expires: year,
    });
    expect(fine.type).toBe("return");
    const [row] = await getDB()
      .select()
      .from(oauthAuthorizations)
      .where(eq(oauthAuthorizations.id, first.id));
    expect(row).toMatchObject({
      accountIds: [mine.id],
      categoryIds: [cat.id],
      scopes: ["transactions:read"],
    });
    expect(row!.connectionExpiresAt!.toISOString().slice(0, 10)).toBe(year);
  });

  describe("write permissions", () => {
    it("need the owner's password", async () => {
      const user = await createTestUser();
      const id = await client();
      const { id: consent } = await consentId(user, id);
      const scope = ["bills:read", "bills:write"];
      const none = await consentAction("approve", user, consent, { scope });
      expect(none).toMatchObject({ type: "fail", status: 400 });
      const wrong = await consentAction("approve", user, consent, {
        scope,
        adminPassword: "not the password",
      });
      expect(wrong).toMatchObject({
        type: "fail",
        data: { errors: { adminPassword: expect.any(Array) } },
      });
      expect(await loadPendingConsent(user.id, consent)).not.toBeNull();
      const right = await consentAction("approve", user, consent, {
        scope,
        adminPassword: user.password,
      });
      expect(right.type).toBe("return");
    });

    it("also need the authenticator code when two-factor is on", async () => {
      const user = await createTestUser();
      await enableTotp(user);
      const id = await client();
      const { id: consent } = await consentId(user, id);
      const out = await consentAction("approve", user, consent, {
        scope: ["transactions:write"],
        adminPassword: user.password,
      });
      expect(out.type).toBe("fail");
    });

    it("are counted after implied permissions are added, so a revert permission cannot hide behind a read", async () => {
      const user = await createTestUser();
      const id = await client();
      const { id: consent } = await consentId(user, id);
      const out = await consentAction("approve", user, consent, {
        scope: ["changes:revert"],
      });
      expect(out.type).toBe("fail");
    });

    it("do not need it for read-only access", async () => {
      const user = await createTestUser();
      const id = await client();
      const { id: consent } = await consentId(user, id);
      const out = await consentAction("approve", user, consent, {
        scope: [...DEFAULT_SCOPES],
      });
      expect(out.type).toBe("return");
    });
  });

  it("works once: a second approval of the same request fails", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id);
    expect(
      (await consentAction("approve", user, consent, { scope: ["bills:read"] }))
        .type,
    ).toBe("return");
    expect(
      (await consentAction("approve", user, consent, { scope: ["bills:read"] }))
        .type,
    ).toBe("fail");
  });

  it("gives the code a short life", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id);
    const before = Date.now();
    await consentAction("approve", user, consent, { scope: ["bills:read"] });
    const [row] = await getDB()
      .select()
      .from(oauthAuthorizations)
      .where(eq(oauthAuthorizations.id, consent));
    const life = row!.expiresAt.getTime() - before;
    expect(life).toBeLessThanOrEqual(CODE_TTL_MS + 5000);
    expect(CODE_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops at the limit of connected apps", async () => {
    const user = await createTestUser();
    const id = await client();
    const now = new Date();
    await getDB()
      .insert(mcpConnections)
      .values(
        Array.from({ length: MAX_ACTIVE_CONNECTIONS }, (_, i) => ({
          userId: user.id,
          clientId: id,
          name: `c${i}`,
          scopes: ["bills:read" as const],
          resource: `${BASE}/api/mcp`,
          createdAt: now,
        })),
      );
    const { id: consent } = await consentId(user, id);
    const out = await consentAction("approve", user, consent, {
      scope: ["bills:read"],
    });
    expect(out.type).toBe("fail");
    expect(
      await getDB()
        .select()
        .from(oauthAuthorizations)
        .where(
          and(
            eq(oauthAuthorizations.id, consent),
            isNull(oauthAuthorizations.codeHash),
          ),
        ),
    ).toHaveLength(1);
  });
});

describe("denying", () => {
  it("tells the client access_denied with its state and the issuer, and drops the request", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id, { state: "keep-me" });
    const out = await consentAction("deny", user, consent, {
      scope: ["bills:read"],
    });
    const url = parseRedirect(
      (out as { value: { redirectTo: string } }).value.redirectTo,
    );
    expect(url.origin + url.pathname).toBe(LOOPBACK);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("keep-me");
    expect(url.searchParams.get("iss")).toBe(BASE);
    expect(url.searchParams.has("code")).toBe(false);
    expect(await loadPendingConsent(user.id, consent)).toBeNull();
    expect((await consentAction("deny", user, consent)).type).toBe("fail");
  });

  it("needs no password and no valid choices", async () => {
    const user = await createTestUser();
    const id = await client();
    const { id: consent } = await consentId(user, id);
    const out = await consentAction("deny", user, consent, {
      scope: ["bills:write", "nonsense"],
    });
    expect(out.type).toBe("return");
  });
});

describe("beginAuthorization", () => {
  it("rejects a request whose repeated parameter could be read two ways", async () => {
    const user = await createTestUser();
    const id = await client();
    const q = authorizeQuery({ clientId: id, challenge: pkce().challenge });
    q.append("redirect_uri", "https://evil.example.org/cb");
    const res = await beginAuthorization(
      user.id,
      q,
      new URL(`${BASE}/oauth/authorize`),
    );
    expect(res.kind).toBe("invalid");
  });
});
