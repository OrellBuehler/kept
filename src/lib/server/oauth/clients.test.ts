import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDB, mcpConnections, oauthClients } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { connect } from "$lib/testing/oauth";
import {
  cleanClientName,
  getClient,
  parseRegistration,
  registerClient,
  sweepUnusedClients,
} from "./clients";
import {
  CLIENT_NAME_MAX,
  MAX_CLIENTS,
  MAX_REDIRECT_URIS,
  UNUSED_CLIENT_TTL_MS,
} from "./config";
import { OAuthError } from "./errors";

const valid = {
  client_name: "Some Client",
  redirect_uris: ["http://127.0.0.1:1234/callback"],
};

function refusal(body: unknown): OAuthError {
  try {
    parseRegistration(body);
  } catch (err) {
    if (err instanceof OAuthError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("client registration: metadata", () => {
  it("accepts what an MCP client sends", () => {
    expect(
      parseRegistration({
        ...valid,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        scope: "anything",
        logo_uri: "https://client.example.org/logo.png",
        software_id: "abc",
      }),
    ).toEqual({
      name: "Some Client",
      redirectUris: valid.redirect_uris,
      clientUri: null,
    });
  });

  it("requires redirect URIs, bounded in number and each one valid", () => {
    expect(refusal({ client_name: "x" }).error).toBe("invalid_redirect_uri");
    expect(refusal({ redirect_uris: [] }).error).toBe("invalid_redirect_uri");
    expect(
      refusal({
        redirect_uris: Array.from(
          { length: MAX_REDIRECT_URIS + 1 },
          (_, i) => `https://client.example.org/${i}`,
        ),
      }).error,
    ).toBe("invalid_redirect_uri");
    for (const uri of [
      "javascript:alert(1)",
      "http://client.example.org/cb",
      "https://client.example.org/cb#x",
      "myapp://cb",
    ]) {
      expect(refusal({ redirect_uris: [uri] }).error, uri).toBe(
        "invalid_redirect_uri",
      );
    }
    expect(refusal({ redirect_uris: "https://client.example.org" }).error).toBe(
      "invalid_redirect_uri",
    );
  });

  it("refuses what Kept does not do instead of pretending", () => {
    for (const extra of [
      { token_endpoint_auth_method: "client_secret_basic" },
      { token_endpoint_auth_method: "private_key_jwt" },
      { grant_types: ["client_credentials"] },
      { grant_types: ["authorization_code", "implicit"] },
      { grant_types: ["refresh_token"] },
      { response_types: ["token"] },
    ]) {
      expect(refusal({ ...valid, ...extra }).error, JSON.stringify(extra)).toBe(
        "invalid_client_metadata",
      );
    }
  });

  it("refuses a body that is not an object of the right shape", () => {
    for (const body of [null, "x", 1, [], { redirect_uris: [1] }]) {
      expect(refusal(body)).toBeInstanceOf(OAuthError);
    }
    expect(refusal({ ...valid, client_name: "x".repeat(2000) }).error).toBe(
      "invalid_client_metadata",
    );
  });

  it("keeps a client_uri only if it is an http(s) URL", () => {
    expect(
      parseRegistration({ ...valid, client_uri: "https://client.example.org" })
        .clientUri,
    ).toBe("https://client.example.org/");
    expect(refusal({ ...valid, client_uri: "javascript:alert(1)" }).error).toBe(
      "invalid_client_metadata",
    );
    expect(refusal({ ...valid, client_uri: "not a url" }).error).toBe(
      "invalid_client_metadata",
    );
  });

  it("de-duplicates redirect URIs", () => {
    expect(
      parseRegistration({
        redirect_uris: [valid.redirect_uris[0], valid.redirect_uris[0]],
      }).redirectUris,
    ).toHaveLength(1);
  });
});

describe("client registration: names are untrusted text", () => {
  it("removes control and formatting characters, collapses space and bounds the length", () => {
    // U+202E reverses what follows on screen; U+200B hides a gap.
    expect(cleanClientName("Safe\u202eenola\u200b  App\n\t")).toBe(
      "Safeenola App",
    );
    expect(cleanClientName("\u0000\u0007")).toBe("Unnamed application");
    expect(cleanClientName(undefined)).toBe("Unnamed application");
    expect(cleanClientName("a".repeat(500))).toHaveLength(CLIENT_NAME_MAX);
  });

  it("keeps markup as plain text for the page to escape", () => {
    expect(cleanClientName("<script>alert(1)</script>")).toBe(
      "<script>alert(1)</script>",
    );
  });
});

describe("client registration: storage is bounded", () => {
  useTestDB();

  const meta = {
    name: "A",
    redirectUris: valid.redirect_uris,
    clientUri: null,
  };

  it("stores a client and finds it by id", async () => {
    const client = await registerClient(meta);
    expect(await getClient(client.id)).toMatchObject({
      name: "A",
      redirectUris: valid.redirect_uris,
    });
    expect(await getClient("")).toBeNull();
    expect(await getClient("x".repeat(200))).toBeNull();
    expect(await getClient("nope")).toBeNull();
  });

  it("evicts the oldest unconnected client when the table is full, and frees room by sweeping unused ones", async () => {
    const now = Date.now();
    await getDB()
      .insert(oauthClients)
      .values(
        Array.from({ length: MAX_CLIENTS }, (_, i) => ({
          name: `c${i}`,
          redirectUris: valid.redirect_uris,
          createdAt: new Date(now - 100_000 + i),
        })),
      );
    const created = await registerClient(meta, now);
    expect(created.name).toBe("A");
    const names = (await getDB().select().from(oauthClients)).map(
      (c) => c.name,
    );
    expect(names).toHaveLength(MAX_CLIENTS);
    expect(names).not.toContain("c0");
    expect(names).toContain("c1");

    // A day later nobody has connected through them: room again.
    const later = now + UNUSED_CLIENT_TTL_MS + 60_000;
    await registerClient({ ...meta, name: "B" }, later);
    expect(await getDB().select().from(oauthClients)).toHaveLength(1);
  });

  it("never evicts a client with a connection, and refuses when every client has one", async () => {
    const user = await createTestUser();
    const now = Date.now();
    await getDB()
      .insert(oauthClients)
      .values(
        Array.from({ length: MAX_CLIENTS }, (_, i) => ({
          name: `c${i}`,
          redirectUris: valid.redirect_uris,
          createdAt: new Date(now - 100_000 + i),
        })),
      );
    const connection = (clientId: string) => ({
      userId: user.id,
      clientId,
      name: "x",
      scopes: ["bills:read" as const],
      resource: "http://localhost/api/mcp",
    });
    // The oldest is connected: the next oldest goes instead.
    const sorted = await getDB().select().from(oauthClients);
    const oldest = sorted.find((c) => c.name === "c0")!;
    await getDB().insert(mcpConnections).values(connection(oldest.id));
    await registerClient(meta, now);
    const after = await getDB().select().from(oauthClients);
    expect(after.map((c) => c.name)).toContain("c0");
    expect(after.map((c) => c.name)).not.toContain("c1");

    await getDB()
      .insert(mcpConnections)
      .values(
        after.filter((c) => c.id !== oldest.id).map((c) => connection(c.id)),
      );
    const err = await registerClient(meta, now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).status).toBe(503);
    expect((err as OAuthError).headers["retry-after"]).toBeDefined();
  });

  it("sweeps clients nobody connected through, but keeps one with a connection", async () => {
    const user = await createTestUser();
    const used = await connect(user);
    const unused = await registerClient(meta);
    await sweepUnusedClients(Date.now() + 60_000);
    expect(await getClient(unused.id)).not.toBeNull();
    const later = Date.now() + UNUSED_CLIENT_TTL_MS + 60_000;
    await sweepUnusedClients(later);
    expect(await getClient(unused.id)).toBeNull();
    expect(await getClient(used.clientId)).not.toBeNull();
    // Once its connection is gone it is unused like any other.
    await getDB()
      .delete(mcpConnections)
      .where(eq(mcpConnections.clientId, used.clientId));
    await sweepUnusedClients(later);
    expect(await getClient(used.clientId)).toBeNull();
  });
});
