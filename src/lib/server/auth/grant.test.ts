import { describe, expect, it } from "vitest";
import type { ApiTokenAuth } from "./api-tokens";
import {
  actorOf,
  grantFromApiToken,
  grantFromConnection,
  hasScope,
  hasScopes,
} from "./grant";

const token = (over: Partial<ApiTokenAuth> = {}): ApiTokenAuth => ({
  id: "tok",
  userId: "usr",
  name: "My token",
  scopes: ["bills:read", "transactions:read"],
  categoryIds: null,
  accountIds: null,
  ...over,
});

describe("grant", () => {
  it("is derived from the token and carries its identity", () => {
    expect(grantFromApiToken(token())).toEqual({
      userId: "usr",
      credential: { kind: "api_token", id: "tok" },
      name: "My token",
      scopes: ["bills:read", "transactions:read"],
      categoryIds: null,
      accountIds: null,
    });
  });

  it("keeps the restrictions and treats a missing account list as all accounts", () => {
    const g = grantFromApiToken(
      token({ categoryIds: ["c"], accountIds: ["a"] }),
    );
    expect(g).toMatchObject({ categoryIds: ["c"], accountIds: ["a"] });
    const legacy = grantFromApiToken({
      ...token(),
      accountIds: undefined as never,
    });
    expect(legacy.accountIds).toBeNull();
  });

  it("drops scopes that cannot honour the restrictions, at request time", () => {
    const g = grantFromApiToken(
      token({
        scopes: [
          "recurring:read",
          "bills:read",
          "balances:read",
          "budgets:read",
        ],
        accountIds: ["a"],
      }),
    );
    expect(g.scopes).toEqual(["bills:read", "balances:read"]);
    const byCategory = grantFromApiToken(
      token({ scopes: ["balances:read", "bills:read"], categoryIds: ["c"] }),
    );
    expect(byCategory.scopes).toEqual(["bills:read"]);
  });

  it("adds implied scopes", () => {
    expect(
      grantFromApiToken(token({ scopes: ["changes:revert"] })).scopes,
    ).toEqual(["changes:revert", "changes:read"]);
  });

  it("checks scopes and names the change-log actor", () => {
    const g = grantFromApiToken(token());
    expect(hasScope(g, "bills:read")).toBe(true);
    expect(hasScope(g, "bills:write")).toBe(false);
    expect(hasScopes(g, ["bills:read", "transactions:read"])).toBe(true);
    expect(hasScopes(g, ["bills:read", "bills:write"])).toBe(false);
    expect(actorOf(g, "mcp")).toEqual({
      kind: "mcp",
      userId: "usr",
      tokenId: "tok",
      label: "My token",
    });
    expect(actorOf(g, "api").kind).toBe("api");
  });

  it("derives a connection's grant the same way, with its own credential kind", () => {
    const g = grantFromConnection({
      id: "conn",
      userId: "usr",
      name: "Editor",
      scopes: ["changes:revert", "balances:read", "bills:read"],
      categoryIds: ["c"],
      accountIds: null,
    });
    expect(g).toEqual({
      userId: "usr",
      credential: { kind: "mcp_connection", id: "conn" },
      name: "Editor",
      // balances:read cannot honour a category restriction; revert brings read along.
      scopes: ["changes:revert", "changes:read", "bills:read"],
      categoryIds: ["c"],
      accountIds: null,
    });
    expect(actorOf(g, "mcp")).toEqual({
      kind: "mcp",
      userId: "usr",
      tokenId: "conn",
      label: "Editor",
    });
  });
});
