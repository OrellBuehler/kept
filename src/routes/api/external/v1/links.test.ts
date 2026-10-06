import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { API_SCOPES } from "$lib/api-tokens";
import { minor } from "$lib/money";
import { deleteBill } from "$lib/server/bills/bills";
import { createCategory } from "$lib/server/categories";
import { externalLinks, getDB, transactions } from "$lib/server/db";
import {
  MAX_LINKS_PER_ENTITY,
  linksByEntity,
  sweepOrphanedLinks,
} from "$lib/server/external-api/links";
import {
  apiAuthFailureLimiter,
  apiTokenLimiter,
} from "$lib/server/external-api/gate";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  callApi,
  seedToken,
  type Body,
  type Item,
} from "$lib/testing/external-api";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";

afterEach(() => {
  apiTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

const ALL = [...API_SCOPES];
const link = (over: Record<string, unknown> = {}) => ({
  source: "hauswart",
  label: "Apartment costs",
  url: "https://home.example.org/costs/1",
  ...over,
});

async function post(
  token: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  const res = await callApi(token, path, { method: "POST", body, headers });
  return {
    status: res.status,
    body: (await res.json()) as Body,
  };
}

async function world() {
  const a = await createTestUser();
  const b = await createTestUser();
  const acct = await seedAccount(a.id);
  const cat = await createCategory(a.id, {
    name: "Housing",
    kind: "expense",
    parentId: null,
    color: null,
    icon: null,
  });
  const bill = await seedBill(a.id);
  const tx = await seedImportedTransaction(a.id, acct.id, {
    categoryId: cat.id,
    amount: minor(-100),
  });
  const hidden = await seedImportedTransaction(a.id, acct.id, {
    amount: minor(-200),
  });
  const theirsBill = await seedBill(b.id);
  const tokenA = (await seedToken(a.id, ALL)).token;
  const tokenB = (await seedToken(b.id, ALL)).token;
  const restricted = (await seedToken(a.id, ALL, { categoryIds: [cat.id] }))
    .token;
  return {
    a,
    b,
    acct,
    cat,
    bill,
    tx,
    hidden,
    theirsBill,
    tokenA,
    tokenB,
    restricted,
  };
}

describe("external links", () => {
  useTestDB();

  it("adds, lists and removes a link on a bill", async () => {
    const w = await world();
    const path = `/api/external/v1/bills/${w.bill.id}/links`;
    const created = await post(w.tokenA, path, link());
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual([
      "createdAt",
      "entityId",
      "entityType",
      "id",
      "label",
      "source",
      "url",
    ]);
    expect(created.body).toMatchObject({
      entityType: "bill",
      entityId: w.bill.id,
      source: "hauswart",
      label: "Apartment costs",
      url: "https://home.example.org/costs/1",
    });

    const listed = await callApi(w.tokenA, path);
    expect(listed.status).toBe(200);
    expect((await listed.json()).items.map((l: Item) => l.id)).toEqual([
      created.body.id,
    ]);

    const del = await callApi(
      w.tokenA,
      `/api/external/v1/links/${created.body.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await (await callApi(w.tokenA, path)).json()).items).toEqual([]);
    expect(
      (
        await callApi(w.tokenA, `/api/external/v1/links/${created.body.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
  });

  it("adds a link on a transaction", async () => {
    const w = await world();
    const path = `/api/external/v1/transactions/${w.tx.id}/links`;
    const created = await post(
      w.tokenA,
      path,
      link({ url: "http://lan.example/a?b=1#c" }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      entityType: "transaction",
      entityId: w.tx.id,
    });
    expect((await (await callApi(w.tokenA, path)).json()).items).toHaveLength(
      1,
    );
  });

  it("is idempotent: the same link again refreshes its label", async () => {
    const w = await world();
    const path = `/api/external/v1/bills/${w.bill.id}/links`;
    const first = await post(w.tokenA, path, link());
    const second = await post(w.tokenA, path, link({ label: "Renamed" }));
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.label).toBe("Renamed");
    // another source or URL is another link
    expect((await post(w.tokenA, path, link({ source: "other" }))).status).toBe(
      201,
    );
    expect(
      (
        await post(
          w.tokenA,
          path,
          link({ url: "https://home.example.org/costs/2" }),
        )
      ).status,
    ).toBe(201);
    expect((await (await callApi(w.tokenA, path)).json()).items).toHaveLength(
      3,
    );
    expect(await getDB().select().from(externalLinks)).toHaveLength(3);
  });

  it("normalises URLs so two spellings are one link", async () => {
    const w = await world();
    const path = `/api/external/v1/bills/${w.bill.id}/links`;
    const a = await post(
      w.tokenA,
      path,
      link({ url: "https://Home.Example.org" }),
    );
    const b = await post(
      w.tokenA,
      path,
      link({ url: "https://home.example.org/" }),
    );
    expect(a.body.url).toBe("https://home.example.org/");
    expect(b.body.id).toBe(a.body.id);
  });

  it.each([
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["file scheme", "file:///etc/passwd"],
    ["ftp scheme", "ftp://example.org/x"],
    ["mixed-case javascript", "JaVaScRiPt:alert(1)"],
    ["relative", "/costs/1"],
    ["protocol-relative", "//example.org/x"],
    ["no scheme", "example.org/x"],
    ["credentials", "https://user:secret@example.org/x"],
    ["username only", "https://user@example.org/x"],
    ["embedded newline", "https://example.org/\nx"],
    ["embedded tab", "https://exa\tmple.org/x"],
    ["space", "https://example.org/a b"],
    ["empty", ""],
    ["blank", "   "],
    ["no host", "https:///x"],
    ["too long", `https://example.org/${"a".repeat(2100)}`],
  ])("rejects a %s URL", async (_, url) => {
    const w = await world();
    const res = await post(
      w.tokenA,
      `/api/external/v1/bills/${w.bill.id}/links`,
      link({ url }),
    );
    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe("string");
    expect(await getDB().select().from(externalLinks)).toEqual([]);
  });

  it("validates the other fields and the request shape", async () => {
    const w = await world();
    const path = `/api/external/v1/bills/${w.bill.id}/links`;
    for (const body of [
      link({ label: "" }),
      link({ label: "x".repeat(201) }),
      link({ label: "a\nb" }),
      link({ source: "" }),
      link({ source: "x".repeat(65) }),
      link({ url: 5 }),
      { source: "a", label: "b" },
      [],
      "text",
      null,
    ]) {
      expect(
        (await post(w.tokenA, path, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    const wrongType = await callApi(w.tokenA, path, {
      method: "POST",
      body: "x",
      headers: { "content-type": "text/plain" },
    });
    expect(wrongType.status).toBe(415);
    const notJson = await callApi(w.tokenA, path, {
      method: "POST",
      body: undefined,
      headers: { "content-type": "application/json" },
    });
    expect(notJson.status).toBe(400);
    expect(await getDB().select().from(externalLinks)).toEqual([]);
  });

  it("caps the links per entity", async () => {
    const w = await world();
    const path = `/api/external/v1/bills/${w.bill.id}/links`;
    for (let i = 0; i < MAX_LINKS_PER_ENTITY; i++) {
      expect(
        (await post(w.tokenA, path, link({ url: `https://example.org/${i}` })))
          .status,
      ).toBe(201);
    }
    const over = await post(
      w.tokenA,
      path,
      link({ url: "https://example.org/over" }),
    );
    expect(over.status).toBe(409);
    // an existing link can still be refreshed
    expect(
      (
        await post(
          w.tokenA,
          path,
          link({ url: "https://example.org/0", label: "again" }),
        )
      ).status,
    ).toBe(200);
  });

  it("keeps links of different users apart: foreign entities and links are 404", async () => {
    const w = await world();
    const mine = await post(
      w.tokenA,
      `/api/external/v1/bills/${w.bill.id}/links`,
      link(),
    );
    // B cannot attach to, list, or delete A's things
    for (const path of [
      `/api/external/v1/bills/${w.bill.id}/links`,
      `/api/external/v1/transactions/${w.tx.id}/links`,
    ]) {
      expect((await post(w.tokenB, path, link())).status, path).toBe(404);
      expect((await callApi(w.tokenB, path)).status, path).toBe(404);
    }
    expect(
      (
        await callApi(w.tokenB, `/api/external/v1/links/${mine.body.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(await getDB().select().from(externalLinks)).toHaveLength(1);
    // and A cannot touch B's bill
    expect(
      (
        await post(
          w.tokenA,
          `/api/external/v1/bills/${w.theirsBill.id}/links`,
          link(),
        )
      ).status,
    ).toBe(404);
    // B's own link is invisible to A
    const theirs = await post(
      w.tokenB,
      `/api/external/v1/bills/${w.theirsBill.id}/links`,
      link(),
    );
    expect(theirs.status).toBe(201);
    expect(
      (
        await callApi(w.tokenA, `/api/external/v1/links/${theirs.body.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(await linksByEntity(w.a.id, "bill", [w.theirsBill.id])).toEqual({});
  });

  it("a link of one entity type cannot be reached through the other", async () => {
    const w = await world();
    // an id of a transaction used on the bills route is just an unknown bill
    expect(
      (await post(w.tokenA, `/api/external/v1/bills/${w.tx.id}/links`, link()))
        .status,
    ).toBe(404);
    expect(
      (
        await post(
          w.tokenA,
          `/api/external/v1/transactions/${w.bill.id}/links`,
          link(),
        )
      ).status,
    ).toBe(404);
  });

  it("a category-restricted token cannot see or link hidden transactions", async () => {
    const w = await world();
    const visible = `/api/external/v1/transactions/${w.tx.id}/links`;
    const hidden = `/api/external/v1/transactions/${w.hidden.id}/links`;
    expect((await post(w.restricted, visible, link())).status).toBe(201);
    expect((await post(w.restricted, hidden, link())).status).toBe(404);
    expect((await callApi(w.restricted, hidden)).status).toBe(404);
    // the owner-level token links the hidden one; the restricted token cannot delete that link
    const made = await post(w.tokenA, hidden, link());
    expect(made.status).toBe(201);
    expect(
      (
        await callApi(w.restricted, `/api/external/v1/links/${made.body.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await callApi(w.tokenA, `/api/external/v1/links/${made.body.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    // bills are not category-bound
    expect(
      (
        await post(
          w.restricted,
          `/api/external/v1/bills/${w.bill.id}/links`,
          link(),
        )
      ).status,
    ).toBe(201);
  });

  it("needs the matching read scope to list, links:write to write", async () => {
    const w = await world();
    const readOnly = (
      await seedToken(w.a.id, ["bills:read", "transactions:read"])
    ).token;
    const writeOnly = (await seedToken(w.a.id, ["links:write"])).token;
    const path = `/api/external/v1/bills/${w.bill.id}/links`;
    expect((await callApi(readOnly, path)).status).toBe(200);
    expect((await post(readOnly, path, link())).status).toBe(403);
    expect((await callApi(writeOnly, path)).status).toBe(403);
    expect((await post(writeOnly, path, link())).status).toBe(201);
    const txOnly = (await seedToken(w.a.id, ["transactions:read"])).token;
    expect((await callApi(txOnly, path)).status).toBe(403);
    const again = await post(writeOnly, path, link());
    expect(again.status).toBe(200);
    expect(
      (
        await callApi(readOnly, `/api/external/v1/links/${again.body.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
  });

  it("hides links whose entity is gone, and the sweep frees their rows", async () => {
    const w = await world();
    await post(w.tokenA, `/api/external/v1/bills/${w.bill.id}/links`, link());
    await post(
      w.tokenA,
      `/api/external/v1/transactions/${w.tx.id}/links`,
      link(),
    );
    const keep = await post(
      w.tokenA,
      `/api/external/v1/transactions/${w.hidden.id}/links`,
      link(),
    );
    await deleteBill(w.a.id, w.bill.id);
    await getDB().delete(transactions).where(eq(transactions.id, w.tx.id));
    expect(await getDB().select().from(externalLinks)).toHaveLength(3);
    for (const path of [
      `/api/external/v1/bills/${w.bill.id}/links`,
      `/api/external/v1/transactions/${w.tx.id}/links`,
    ]) {
      expect((await callApi(w.tokenA, path)).status, path).toBe(404);
    }
    await sweepOrphanedLinks();
    const rows = await getDB().select().from(externalLinks);
    expect(rows.map((r) => r.id)).toEqual([keep.body.id]);
  });

  it("links disappear with their user", async () => {
    const w = await world();
    await post(w.tokenA, `/api/external/v1/bills/${w.bill.id}/links`, link());
    const { users } = await import("$lib/server/db");
    await getDB().delete(users).where(eq(users.id, w.a.id));
    expect(await getDB().select().from(externalLinks)).toEqual([]);
  });

  it("answers errors as JSON and never echoes the token", async () => {
    const w = await world();
    const res = await callApi(
      w.tokenA,
      `/api/external/v1/bills/${w.bill.id}/links`,
      {
        method: "POST",
        body: link({ url: "javascript:1" }),
      },
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(await res.json())).not.toContain(w.tokenA);
  });
});
