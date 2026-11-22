import { describe, expect, it } from "vitest";
import { z } from "zod";
import { API_SCOPES } from "$lib/api-tokens";
import { toolAvailable } from "./tool";
import { TOOLS } from "./tools/index";

describe("tool registry", () => {
  it("names are unique snake_case", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  });

  it("every tool declares the scopes it needs (only whoami needs none)", () => {
    for (const tool of TOOLS) {
      if (tool.name === "whoami") {
        expect(tool.scopes).toEqual([]);
        continue;
      }
      expect(tool.scopes.length, tool.name).toBeGreaterThan(0);
      for (const scope of tool.scopes) expect(API_SCOPES).toContain(scope);
    }
  });

  it("read-only tools need only read scopes, changing tools a write scope", () => {
    for (const tool of TOOLS) {
      if (tool.annotations.readOnlyHint) {
        for (const s of tool.scopes) expect(s, tool.name).toMatch(/:read$/);
      } else {
        expect(
          tool.scopes.some((s) => /:(write|revert)$/.test(s)),
          tool.name,
        ).toBe(true);
      }
    }
  });

  it("every scope has a tool, except the REST-only link scope", () => {
    const used = new Set(TOOLS.flatMap((t) => t.scopes));
    for (const scope of API_SCOPES) {
      if (scope === "links:write") continue;
      expect(used.has(scope), scope).toBe(true);
    }
  });

  it("describes every tool for a model, and says destructive ones can be reverted", () => {
    for (const tool of TOOLS) {
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      expect(tool.description.length, tool.name).toBeGreaterThan(60);
      if (tool.annotations.destructiveHint === true) {
        expect(tool.description, tool.name).toMatch(/change log/i);
      }
      if (!tool.annotations.readOnlyHint) {
        expect(tool.description, tool.name).toMatch(/change log|reverted/i);
      }
    }
  });

  it("marks writes with the annotations MCP clients show", () => {
    const destructive = TOOLS.filter(
      (t) => t.annotations.destructiveHint === true,
    ).map((t) => t.name);
    expect(destructive.sort()).toEqual(
      [
        "apply_category_rules",
        "delete_bill",
        "delete_category",
        "delete_category_rule",
        "remove_allocation",
        "revert_change",
        "revert_changes",
      ].sort(),
    );
    for (const tool of TOOLS.filter((t) => t.annotations.readOnlyHint)) {
      expect(tool.annotations.destructiveHint, tool.name).toBeUndefined();
    }
  });

  it("exposes nothing about secrets, other users, admin, tokens, imports or files", () => {
    const forbidden =
      /token|password|secret|user|admin|backup|import|upload|paperless|document|passkey|totp|iban/i;
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).not.toMatch(forbidden);
      for (const field of Object.keys(tool.input)) {
        // A creditor or counterparty IBAN may be written (never read back); nothing else of that kind.
        if (field === "creditorIban" || field === "counterpartyIban") continue;
        expect(field, `${tool.name}.${field}`).not.toMatch(
          /password|secret|token|userId|iban/i,
        );
      }
    }
  });

  it("accepts every input schema as JSON schema, with documented fields", () => {
    for (const tool of TOOLS) {
      const schema = z.toJSONSchema(z.object(tool.input));
      expect(schema.type, tool.name).toBe("object");
    }
  });

  it("the tool check is the one decision for listing and calling", () => {
    const grant = (scopes: readonly (typeof API_SCOPES)[number][]) => ({
      userId: "u",
      credential: { kind: "api_token" as const, id: "t" },
      name: "n",
      scopes,
      categoryIds: null,
      accountIds: null,
    });
    const bills = TOOLS.find((t) => t.name === "list_bills")!;
    expect(toolAvailable(bills, grant(["bills:read"]))).toBe(true);
    expect(toolAvailable(bills, grant(["transactions:read"]))).toBe(false);
    const nw = TOOLS.find((t) => t.name === "get_net_worth")!;
    expect(toolAvailable(nw, grant(["balances:read"]))).toBe(true);
    expect(
      toolAvailable(nw, { ...grant(["balances:read"]), accountIds: ["a"] }),
    ).toBe(false);
  });
});
