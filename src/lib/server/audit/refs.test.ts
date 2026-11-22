import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { billInput } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { callTool } from "$lib/testing/mcp";
import { connect } from "$lib/testing/oauth";
import { renameConnection } from "$lib/server/oauth/connections";
import { createBill } from "$lib/server/bills/bills";
import { createCategory } from "$lib/server/categories/categories";
import { runAsActor } from "./context";
import { listChanges } from "./list";
import {
  collectReferenceIds,
  listChangeActors,
  resolveReferences,
} from "./refs";

useTestDB();

const cat = (name: string) => ({
  name,
  kind: "expense" as const,
  parentId: null,
  color: null,
  icon: null,
});

describe("collectReferenceIds", () => {
  it("collects the entity and every reference field, once", () => {
    const ids = collectReferenceIds([
      {
        entityType: "bill",
        entityId: "b1",
        before: { expectedAccountId: "a1" },
        after: { expectedAccountId: "a2", categoryId: "c1", note: "x" },
      },
      {
        entityType: "allocation",
        entityId: "al1",
        before: null,
        after: { billId: "b1", transactionId: "t1" },
      },
    ]);
    expect([...ids.bill].sort()).toEqual(["b1"]);
    expect([...ids.account].sort()).toEqual(["a1", "a2"]);
    expect([...ids.category]).toEqual(["c1"]);
    expect([...ids.transaction]).toEqual(["t1"]);
  });
});

describe("resolveReferences", () => {
  it("names the user's own records and leaves foreign and deleted ones out", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = await createCategory(a.id, cat("Mine"));
    const theirs = await createCategory(b.id, cat("Theirs"));
    const bill = await createBill(a.id, billInput({ creditorName: "Example" }));
    const entries = [
      {
        entityType: "category",
        entityId: mine.id,
        before: null,
        after: { parentId: theirs.id },
      },
      { entityType: "bill", entityId: bill.id, before: null, after: null },
    ] as never;
    const refs = await resolveReferences(a.id, entries);
    expect(refs.categories).toEqual({ [mine.id]: "Mine" });
    expect(refs.bills[bill.id]?.name).toBe("Example");
    expect(refs.accounts).toEqual({});
  });
});

describe("listChangeActors", () => {
  it("lists each token once with its latest name, only for the user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const as = (u: { id: string }, tokenId: string, label: string) =>
      runAsActor({ kind: "mcp", userId: u.id, tokenId, label }, () =>
        createBill(u.id, billInput()),
      );
    await as(a, "t1", "Old name");
    await as(a, "t1", "New name");
    await as(a, "t2", "Other");
    await as(b, "t3", "Theirs");
    await createBill(a.id, billInput());
    expect(await listChangeActors(a.id)).toEqual([
      { kind: "mcp", tokenId: "t2", label: "Other" },
      { kind: "mcp", tokenId: "t1", label: "New name" },
    ]);
    expect((await listChanges(a.id)).items).toHaveLength(4);
  });
});

describe("listChangeActors: connections made by signing in", () => {
  it("lists an OAuth connection by its id with its name, and follows a rename", async () => {
    const a = await createTestUser();
    const c = await connect(a, {
      scopes: ["bills:write"],
      name: "Editor",
      password: a.password,
    });
    const created = await callTool(c.accessToken, "create_bill", {
      creditorName: "Example Supplier",
      amount: "5.00",
    });
    expect(created.isError, created.text).toBe(false);

    const [before] = await listChangeActors(a.id);
    expect(before).toMatchObject({ kind: "mcp", tokenId: c.connectionId });
    expect(before!.label).toBeTruthy();
    const entries = (await listChanges(a.id, { tokenId: c.connectionId }))
      .items;
    expect(entries.map((e) => e.actor)).toEqual([
      { kind: "mcp", tokenId: c.connectionId, label: before!.label },
    ]);

    await renameConnection(a.id, c.connectionId, "Renamed editor");
    await callTool(c.accessToken, "create_bill", {
      creditorName: "Second Supplier",
      amount: "6.00",
    });
    expect(await listChangeActors(a.id)).toEqual([
      { kind: "mcp", tokenId: c.connectionId, label: "Renamed editor" },
    ]);
  });
});
