import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { grantFromApiToken } from "$lib/server/auth/grant";
import { useTestDB } from "$lib/testing/db";
import { seedToken } from "$lib/testing/external-api";
import { buildWorld } from "$lib/testing/mcp-world";
import { callTool } from "$lib/testing/mcp";
import { createMcpServer } from "./server";
import { defineTool } from "./tool";

afterEach(() => vi.restoreAllMocks());

const SECRET = "text-from-a-payment";

describe("mcp server: invalid input", () => {
  useTestDB();

  it("answers an empty id filter as invalid input, not as an unexpected error, and logs nothing", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ["transactions:read"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const args of [{ accountId: "" }, { categoryId: "" }]) {
      const r = await callTool(token, "list_transactions", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).not.toMatch(/unexpected/i);
      expect(r.text).toMatch(/accountId|categoryId/);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it("turns a refusal of a service's own schema into an invalid-input tool error that names the field, not the value", async () => {
    const w = await buildWorld();
    const { info } = await seedToken(w.a.id, ["transactions:read"]);
    const grant = grantFromApiToken({
      id: info.id,
      userId: w.a.id,
      name: "t",
      scopes: ["transactions:read"],
      categoryIds: null,
      accountIds: null,
    });
    const tool = defineTool({
      name: "refuses",
      title: "Refuses",
      description: "Throws what a service's schema throws.",
      scopes: ["transactions:read"],
      annotations: { readOnlyHint: true },
      input: {},
      run: async () => {
        z.object({ accountId: z.string().min(1) }).parse({ accountId: "" });
        return {};
      },
    });
    const throwing = defineTool({
      name: "refuses_value",
      title: "Refuses a value",
      description: "Throws a schema error whose message echoes a value.",
      scopes: ["transactions:read"],
      annotations: { readOnlyHint: true },
      input: {},
      run: async () => {
        z.object({ q: z.literal("fixed") }).parse({ q: SECRET });
        return {};
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createMcpServer(grant, "http://localhost", [tool, throwing]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);

    const one = (await client.callTool({ name: "refuses" })) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(one.isError).toBe(true);
    expect(one.content[0]!.text).toBe("Invalid input: accountId.");

    const two = (await client.callTool({ name: "refuses_value" })) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(two.isError).toBe(true);
    expect(two.content[0]!.text).toBe("Invalid input: q.");
    expect(two.content[0]!.text).not.toContain(SECRET);
    expect(errors).not.toHaveBeenCalled();
    await client.close();
  });
});
