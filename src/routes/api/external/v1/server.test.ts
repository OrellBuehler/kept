import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { API_SCOPES, type ApiScope } from "$lib/api-tokens";
import {
  billAllocations,
  getDB,
  recurringSeries,
  transactions,
} from "$lib/server/db";
import { allocate } from "$lib/server/bills/allocations";
import { createCategory } from "$lib/server/categories";
import { createTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import {
  callApi,
  seedToken,
  type Body,
  type Item,
} from "$lib/testing/external-api";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { eq } from "drizzle-orm";
import {
  apiAuthFailureLimiter,
  apiTokenLimiter,
} from "$lib/server/external-api/gate";
import { afterEach } from "vitest";

afterEach(() => {
  apiTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

const ALL = [...API_SCOPES];

async function json(res: Response) {
  return (await res.json()) as Body;
}

async function get(token: string, path: string) {
  const res = await callApi(token, path);
  return { status: res.status, body: await json(res), res };
}

async function category(
  userId: string,
  name: string,
  parentId: string | null = null,
) {
  return createCategory(userId, {
    name,
    kind: "expense",
    parentId,
    color: "#112233",
    icon: null,
  });
}

/** Collects every page of a list endpoint. */
async function collect(token: string, path: string, limit: number) {
  const items: Item[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const { status, body } = await get(
      token,
      `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(status).toBe(200);
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("pagination did not end");
}

const FORBIDDEN_KEYS =
  /iban|reference|externalId|passwordHash|tokenHash|userId/i;

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

function expectNoLeak(body: unknown) {
  const text = JSON.stringify(body);
  for (const secret of [EXAMPLE_IBAN, EXAMPLE_IBAN_OTHER, EXAMPLE_QRR]) {
    expect(text).not.toContain(secret);
  }
  expect([...keysOf(body)].filter((k) => FORBIDDEN_KEYS.test(k))).toEqual([]);
}

describe("external API: access", () => {
  useTestDB();

  const endpoints: [string, ApiScope][] = [
    ["/api/external/v1/bills", "bills:read"],
    ["/api/external/v1/bills/x", "bills:read"],
    ["/api/external/v1/transactions", "transactions:read"],
    ["/api/external/v1/transactions/x", "transactions:read"],
    ["/api/external/v1/categories", "categories:read"],
    ["/api/external/v1/recurring-series", "recurring:read"],
    ["/api/external/v1/accounts", "accounts:read"],
  ];

  it.each(endpoints)("%s needs the %s scope", async (path, scope) => {
    const u = await createTestUser();
    const others = ALL.filter((s) => s !== scope);
    const without = await seedToken(u.id, others);
    const res = await callApi(without.token, path);
    expect(res.status).toBe(403);
    expect((await json(res)).message).toContain(scope);

    const withScope = await seedToken(u.id, [scope]);
    expect((await callApi(withScope.token, path)).status).not.toBe(403);
  });

  it("the cookie of a logged-in user is no substitute for a token", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ALL);
    const res = await callApi(null, "/api/external/v1/me", {
      cookies: { kept_session: token },
    });
    expect(res.status).toBe(401);
  });

  it("a category-restricted token cannot read recurring series", async () => {
    const u = await createTestUser();
    const cat = await category(u.id, "Housing");
    const { token } = await seedToken(u.id, ["recurring:read"], {
      categoryIds: [cat.id],
    });
    expect((await get(token, "/api/external/v1/recurring-series")).status).toBe(
      403,
    );
  });

  it("no method reaches a token route with a cookie only", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ALL);
    for (const method of [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]) {
      const res = await callApi(null, "/api/external/v1/bills", {
        method,
        cookies: { kept_session: token },
        body:
          method === "GET" || method === "HEAD" || method === "OPTIONS"
            ? undefined
            : {},
      });
      expect(res.status, method).toBe(401);
    }
  });

  it("answers unknown paths with JSON 404 and wrong methods with 405", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ALL);
    const unknown = await callApi(token, "/api/external/v1/nope/deeper");
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toEqual({ message: "Endpoint not found." });
    const wrong = await callApi(token, "/api/external/v1/bills", {
      method: "POST",
      body: {},
    });
    expect(wrong.status).toBe(405);
    expect(await json(wrong)).toEqual({ message: "Method not allowed" });
  });

  it("GET /me describes the owner and the token", async () => {
    const u = await createTestUser({
      username: "meuser",
      displayName: "Me User",
    });
    const cat = await category(u.id, "Housing");
    const { token } = await seedToken(u.id, ["bills:read"], {
      categoryIds: [cat.id],
    });
    const { status, body } = await get(token, "/api/external/v1/me");
    expect(status).toBe(200);
    expect(body).toEqual({
      id: u.id,
      username: "meuser",
      displayName: "Me User",
      locale: "en-GB",
      defaultCurrency: "CHF",
      token: { scopes: ["bills:read"], categoryIds: [cat.id] },
    });
  });

  it("a token stops working with its user", async () => {
    const u = await createTestUser();
    const { token } = await seedToken(u.id, ALL);
    const { users } = await import("$lib/server/db");
    await getDB().delete(users).where(eq(users.id, u.id));
    expect((await callApi(token, "/api/external/v1/me")).status).toBe(401);
  });
});

describe("external API: bills", () => {
  useTestDB();

  async function world() {
    const a = await createTestUser();
    const b = await createTestUser();
    const acct = await seedAccount(a.id);
    const day = (n: number) =>
      `2026-${String(Math.floor(n / 28) + 1).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}`;
    const mine = [];
    for (let i = 0; i < 7; i++) {
      mine.push(
        await seedBill(a.id, {
          creditorName: `Supplier ${i}`,
          creditorIban: EXAMPLE_IBAN,
          reference: EXAMPLE_QRR,
          referenceType: "QRR",
          amount: minor(10000 + i),
          dueDate: day(i * 3),
          invoiceNumber: `INV-${i}`,
          notes: `note ${i}`,
        }),
      );
    }
    const open = await seedBill(a.id, {
      amount: null,
      dueDate: null,
      creditorName: "No date",
    });
    const theirs = await seedBill(b.id, {
      creditorName: "Theirs",
      dueDate: "2026-01-01",
    });
    const { token } = await seedToken(a.id, ["bills:read"]);
    const tokenB = await seedToken(b.id, ["bills:read"]);
    return { a, b, acct, mine, open, theirs, token, tokenB: tokenB.token };
  }

  it("lists only the owner's bills, with the documented fields and nothing secret", async () => {
    const w = await world();
    const { status, body } = await get(w.token, "/api/external/v1/bills");
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(8);
    expect(body.items.map((i: Item) => i.id)).not.toContain(w.theirs.id);
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        "amount",
        "creditorName",
        "currency",
        "dueDate",
        "id",
        "invoiceNumber",
        "issueDate",
        "kind",
        "lastPaymentDate",
        "notes",
        "overdue",
        "paidAmount",
        "remainingAmount",
        "status",
        "updatedAt",
        "url",
      ].sort(),
    );
    expectNoLeak(body);
    const first = body.items[0];
    expect(first).toMatchObject({
      id: w.mine[0]!.id,
      kind: "invoice",
      creditorName: "Supplier 0",
      amount: 10000,
      currency: "CHF",
      invoiceNumber: "INV-0",
      status: "open",
      paidAmount: 0,
      remainingAmount: 10000,
      notes: "note 0",
      url: `http://localhost/bills/${w.mine[0]!.id}`,
    });
    expect(new Date(first.updatedAt).toISOString()).toBe(first.updatedAt);
    // undated bills sort last
    expect(body.items.at(-1)!.id).toBe(w.open.id);
  });

  it("uses ORIGIN for absolute links when it is set", async () => {
    const w = await world();
    const before = process.env.ORIGIN;
    process.env.ORIGIN = "https://kept.example.org/ignored/path";
    try {
      const { body } = await get(
        w.token,
        `/api/external/v1/bills/${w.mine[0]!.id}`,
      );
      expect(body.url).toBe(`https://kept.example.org/bills/${w.mine[0]!.id}`);
    } finally {
      if (before === undefined) delete process.env.ORIGIN;
      else process.env.ORIGIN = before;
    }
  });

  it("never shows one user's bills to another user's token", async () => {
    const w = await world();
    const theirs = await get(w.tokenB, "/api/external/v1/bills");
    expect(theirs.body.items.map((i: Item) => i.id)).toEqual([w.theirs.id]);
    for (const bill of w.mine) {
      const res = await get(w.tokenB, `/api/external/v1/bills/${bill.id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: "Bill not found." });
    }
    expect(
      (await get(w.token, `/api/external/v1/bills/${w.theirs.id}`)).status,
    ).toBe(404);
  });

  it("returns one bill", async () => {
    const w = await world();
    const { status, body } = await get(
      w.token,
      `/api/external/v1/bills/${w.mine[2]!.id}`,
    );
    expect(status).toBe(200);
    expect(body.id).toBe(w.mine[2]!.id);
    expectNoLeak(body);
    expect(
      (await get(w.token, "/api/external/v1/bills/does-not-exist")).status,
    ).toBe(404);
  });

  it("computes status like the bill list: paid, partially paid, overdue, cancelled", async () => {
    const w = await world();
    const paid = w.mine[0]!;
    const partial = w.mine[1]!;
    const tx1 = await seedImportedTransaction(w.a.id, w.acct.id, {
      amount: minor(-10000),
      bookingDate: "2026-02-01",
    });
    const tx2 = await seedImportedTransaction(w.a.id, w.acct.id, {
      amount: minor(-4000),
      bookingDate: "2026-02-03",
    });
    await allocate(w.a.id, paid.id, tx1.id, minor(10000), "user");
    await allocate(w.a.id, partial.id, tx2.id, minor(4000), "user");
    const { cancelBill } = await import("$lib/server/bills/bills");
    await cancelBill(w.a.id, w.mine[3]!.id);

    const byId = async (id: string) =>
      (await get(w.token, `/api/external/v1/bills/${id}`)).body;
    expect(await byId(paid.id)).toMatchObject({
      status: "paid",
      paidAmount: 10000,
      remainingAmount: 0,
      lastPaymentDate: "2026-02-01",
      overdue: false,
    });
    expect(await byId(partial.id)).toMatchObject({
      status: "partially_paid",
      paidAmount: 4000,
      remainingAmount: 6001,
    });
    expect(await byId(w.mine[3]!.id)).toMatchObject({
      status: "cancelled",
      overdue: false,
    });
    // due 2026-01-01.. earlier than any "today" after that: open + past due => overdue
    expect(await byId(w.mine[2]!.id)).toMatchObject({
      status: "open",
      overdue: true,
    });
  });

  it("filters by status with the list's semantics", async () => {
    const w = await world();
    const tx = await seedImportedTransaction(w.a.id, w.acct.id, {
      amount: minor(-10000),
    });
    await allocate(w.a.id, w.mine[0]!.id, tx.id, minor(10000), "user");
    const { cancelBill } = await import("$lib/server/bills/bills");
    await cancelBill(w.a.id, w.mine[1]!.id);
    const ids = async (q: string) =>
      (await get(w.token, `/api/external/v1/bills?${q}`)).body.items
        .map((i: Item) => i.id)
        .sort();

    expect(await ids("status=paid")).toEqual([w.mine[0]!.id]);
    expect(await ids("status=cancelled")).toEqual([w.mine[1]!.id]);
    const overdue = await ids("status=overdue");
    const open = await ids("status=open");
    // open and overdue never overlap; together with paid and cancelled they cover everything
    expect(overdue.filter((i: string) => open.includes(i))).toEqual([]);
    expect(open).toContain(w.open.id);
    expect(overdue).not.toContain(w.open.id);
    expect(await ids("status=open,overdue,paid,cancelled")).toHaveLength(8);
    expect(await ids("status=paid,cancelled")).toEqual(
      [w.mine[0]!.id, w.mine[1]!.id].sort(),
    );
    expect(await ids("")).toHaveLength(8);
  });

  it("filters by due date range and drops undated bills then", async () => {
    const w = await world();
    const all = (await get(w.token, "/api/external/v1/bills")).body.items;
    const dated = all.filter((i: Item) => i.dueDate);
    const from = dated[2].dueDate;
    const to = dated[4].dueDate;
    const { body } = await get(
      w.token,
      `/api/external/v1/bills?dueFrom=${from}&dueTo=${to}`,
    );
    expect(body.items.map((i: Item) => i.id)).toEqual([
      dated[2].id,
      dated[3].id,
      dated[4].id,
    ]);
    expect(
      (
        await get(w.token, `/api/external/v1/bills?dueFrom=${from}`)
      ).body.items.every((i: Item) => i.dueDate! >= from!),
    ).toBe(true);
  });

  it("paginates by due date without gaps or repeats", async () => {
    const w = await world();
    const everything = (await get(w.token, "/api/external/v1/bills?limit=200"))
      .body.items;
    for (const limit of [1, 2, 3, 8, 200]) {
      const paged = await collect(w.token, "/api/external/v1/bills", limit);
      expect(
        paged.map((i) => i.id),
        `limit ${limit}`,
      ).toEqual(everything.map((i: Item) => i.id));
    }
    const { body } = await get(w.token, "/api/external/v1/bills?limit=3");
    expect(body.items).toHaveLength(3);
    expect(typeof body.nextCursor).toBe("string");
  });

  it("supports updatedSince, including changes that only touch allocations", async () => {
    const w = await world();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (await get(w.token, `/api/external/v1/bills?updatedSince=${future}`)).body
        .items,
    ).toEqual([]);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      (await get(w.token, `/api/external/v1/bills?updatedSince=${past}`)).body
        .items,
    ).toHaveLength(8);

    // age everything, then allocate a payment: only that bill is "updated"
    const { bills } = await import("$lib/server/db");
    const old = new Date("2026-01-01T00:00:00Z");
    await getDB().update(bills).set({ updatedAt: old });
    const cutoff = "2026-06-01T00:00:00Z";
    expect(
      (await get(w.token, `/api/external/v1/bills?updatedSince=${cutoff}`)).body
        .items,
    ).toEqual([]);
    const tx = await seedImportedTransaction(w.a.id, w.acct.id, {
      amount: minor(-10000),
    });
    await allocate(w.a.id, w.mine[0]!.id, tx.id, minor(10000), "user");
    const { body } = await get(
      w.token,
      `/api/external/v1/bills?updatedSince=${cutoff}`,
    );
    expect(body.items.map((i: Item) => i.id)).toEqual([w.mine[0]!.id]);
    expect(new Date(body.items[0].updatedAt).getTime()).toBeGreaterThan(
      old.getTime(),
    );
  });

  it("rejects bad query parameters with 400 and a message", async () => {
    const w = await world();
    for (const q of [
      "limit=0",
      "limit=201",
      "limit=abc",
      "limit=-1",
      "status=unknown",
      "dueFrom=2026-13-45",
      "dueTo=yesterday",
      "updatedSince=2026-01-01",
      "updatedSince=nope",
      "cursor=not-a-cursor",
      `cursor=${Buffer.from("[1,2,3]").toString("base64url")}`,
      `cursor=${Buffer.from('{"a":1}').toString("base64url")}`,
    ]) {
      const { status, body } = await get(
        w.token,
        `/api/external/v1/bills?${q}`,
      );
      expect(status, q).toBe(400);
      expect(typeof body.message, q).toBe("string");
    }
  });

  it("ignores unknown query parameters and a repeated parameter's later values", async () => {
    const w = await world();
    const { status, body } = await get(
      w.token,
      "/api/external/v1/bills?limit=2&limit=500&foo=bar",
    );
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
  });
});

describe("external API: transactions and categories", () => {
  useTestDB();

  async function world() {
    const a = await createTestUser();
    const b = await createTestUser();
    const acct = await seedAccount(a.id, { name: "Main", iban: EXAMPLE_IBAN });
    const acct2 = await seedAccount(a.id, { name: "Second" });
    const acctB = await seedAccount(b.id, { name: "Theirs" });
    const rent = await category(a.id, "Rent");
    const food = await category(a.id, "Food");
    const sub = await category(a.id, "Groceries", food.id);
    const tooB = await category(b.id, "Rent");
    const rows = [];
    // 5 rows share a booking date to exercise the (date, seq, id) cursor
    for (let i = 0; i < 12; i++) {
      rows.push(
        await seedImportedTransaction(a.id, i % 4 === 3 ? acct2.id : acct.id, {
          bookingDate:
            i < 5 ? "2026-03-10" : `2026-03-${String(11 + i).padStart(2, "0")}`,
          amount: minor(-1000 - i),
          counterpartyName: i % 2 === 0 ? `Landlord ${i}` : `Shop ${i}`,
          counterpartyIban: EXAMPLE_IBAN_OTHER,
          description: i % 2 === 0 ? `rent payment ${i}` : `groceries ${i}`,
          reference: EXAMPLE_QRR,
          categoryId: i % 3 === 0 ? rent.id : i % 3 === 1 ? sub.id : null,
          note: `private note ${i}`,
        }),
      );
    }
    const theirs = await seedImportedTransaction(b.id, acctB.id, {
      amount: minor(-5),
      categoryId: tooB.id,
      description: "theirs",
    });
    const full = await seedToken(a.id, [
      "transactions:read",
      "categories:read",
    ]);
    const restricted = await seedToken(
      a.id,
      ["transactions:read", "categories:read"],
      {
        categoryIds: [rent.id],
      },
    );
    const tokenB = await seedToken(b.id, [
      "transactions:read",
      "categories:read",
    ]);
    return {
      a,
      b,
      acct,
      acct2,
      rent,
      food,
      sub,
      rows,
      theirs,
      full: full.token,
      restricted: restricted.token,
      tokenB: tokenB.token,
    };
  }

  it("lists only the owner's transactions, newest first, as DTOs without secrets", async () => {
    const w = await world();
    const { status, body } = await get(
      w.full,
      "/api/external/v1/transactions?limit=200",
    );
    expect(status).toBe(200);
    expect(body.items).toHaveLength(12);
    expect(body.items.map((i: Item) => i.id)).not.toContain(w.theirs.id);
    const dates = body.items.map((i: Item) => i.bookingDate);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        "accountId",
        "amount",
        "billIds",
        "bookingDate",
        "categoryId",
        "counterpartyName",
        "currency",
        "description",
        "id",
        "updatedAt",
        "url",
      ].sort(),
    );
    expectNoLeak(body);
    expect(JSON.stringify(body)).not.toContain("private note");
    const row = body.items.find((i: Item) => i.id === w.rows[0]!.id);
    expect(row).toMatchObject({
      accountId: w.acct.id,
      bookingDate: "2026-03-10",
      amount: -1000,
      currency: "CHF",
      counterpartyName: "Landlord 0",
      description: "rent payment 0",
      categoryId: w.rent.id,
      billIds: [],
      url: `http://localhost/accounts/${w.acct.id}?tx=${w.rows[0]!.id}`,
    });
  });

  it("never shows another user's transactions, not even by id", async () => {
    const w = await world();
    const theirs = await get(w.tokenB, "/api/external/v1/transactions");
    expect(theirs.body.items.map((i: Item) => i.id)).toEqual([w.theirs.id]);
    for (const row of w.rows) {
      expect(
        (await get(w.tokenB, `/api/external/v1/transactions/${row.id}`)).status,
      ).toBe(404);
    }
    expect(
      (await get(w.full, `/api/external/v1/transactions/${w.theirs.id}`))
        .status,
    ).toBe(404);
    // filtering by someone else's account or category finds nothing
    const acctB = w.theirs.accountId;
    expect(
      (await get(w.full, `/api/external/v1/transactions?accountId=${acctB}`))
        .body.items,
    ).toEqual([]);
    expect(
      (
        await get(
          w.full,
          `/api/external/v1/transactions?categoryId=${w.theirs.categoryId}`,
        )
      ).body.items,
    ).toEqual([]);
  });

  it("returns one transaction", async () => {
    const w = await world();
    const { status, body } = await get(
      w.full,
      `/api/external/v1/transactions/${w.rows[1]!.id}`,
    );
    expect(status).toBe(200);
    expect(body.id).toBe(w.rows[1]!.id);
    expectNoLeak(body);
  });

  it("filters by date range, account, category and text", async () => {
    const w = await world();
    const ids = async (q: string) =>
      (
        await get(w.full, `/api/external/v1/transactions?limit=200&${q}`)
      ).body.items.map((i: Item) => i.id);
    expect(await ids("from=2026-03-11")).toHaveLength(12 - 5);
    expect(await ids("to=2026-03-10")).toHaveLength(5);
    expect(await ids("from=2026-03-10&to=2026-03-10")).toHaveLength(5);
    expect((await ids(`accountId=${w.acct2.id}`)).sort()).toEqual(
      w.rows
        .filter((_, i) => i % 4 === 3)
        .map((r) => r.id)
        .sort(),
    );
    expect((await ids(`categoryId=${w.rent.id}`)).sort()).toEqual(
      w.rows
        .filter((_, i) => i % 3 === 0)
        .map((r) => r.id)
        .sort(),
    );
    expect(await ids("q=landlord")).toHaveLength(6);
    expect(await ids("q=LANDLORD%205")).toHaveLength(0);
    expect(await ids("q=100%25")).toHaveLength(0);
    expect(await ids("q=_")).toHaveLength(0);
    // the note is not searchable: it is not part of the DTO
    expect(await ids("q=private%20note")).toHaveLength(0);
  });

  it("paginates with a stable cursor even when rows share a booking date", async () => {
    const w = await world();
    const everything = (
      await get(w.full, "/api/external/v1/transactions?limit=200")
    ).body.items.map((i: Item) => i.id);
    expect(everything).toHaveLength(12);
    for (const limit of [1, 2, 5, 7, 11, 12, 200]) {
      const paged = await collect(
        w.full,
        "/api/external/v1/transactions",
        limit,
      );
      expect(
        paged.map((i) => i.id),
        `limit ${limit}`,
      ).toEqual(everything);
    }
  });

  it("supports updatedSince", async () => {
    const w = await world();
    const old = new Date("2026-01-01T00:00:00Z");
    await getDB().update(transactions).set({ updatedAt: old });
    const cutoff = "2026-06-01T00:00:00Z";
    expect(
      (
        await get(
          w.full,
          `/api/external/v1/transactions?updatedSince=${cutoff}`,
        )
      ).body.items,
    ).toEqual([]);
    await getDB()
      .update(transactions)
      .set({ note: "touched" })
      .where(eq(transactions.id, w.rows[4]!.id));
    const { body } = await get(
      w.full,
      `/api/external/v1/transactions?updatedSince=${cutoff}`,
    );
    expect(body.items.map((i: Item) => i.id)).toEqual([w.rows[4]!.id]);
  });

  it("an allocation counts as an update of the transaction", async () => {
    const w = await world();
    await getDB()
      .update(transactions)
      .set({ updatedAt: new Date("2026-01-01T00:00:00Z") });
    const cutoff = "2026-06-01T00:00:00Z";
    const bill = await seedBill(w.a.id, { amount: minor(2000) });
    await allocate(w.a.id, bill.id, w.rows[0]!.id, minor(1000), "user");
    const { body } = await get(
      w.full,
      `/api/external/v1/transactions?updatedSince=${cutoff}`,
    );
    expect(body.items.map((i: Item) => i.id)).toEqual([w.rows[0]!.id]);
    expect(new Date(body.items[0]!.updatedAt).getTime()).toBeGreaterThan(
      new Date(cutoff).getTime(),
    );
  });

  it("rejects forged cursors with 400", async () => {
    const w = await world();
    const enc = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const c of [
      ["2026-01-01", 2 ** 60, "x"],
      ["2026-01-01", -1, "x"],
      ["2026-01-01", 1.5, "x"],
      ["not a date", 1, "x"],
      ["2026-01-01", 1, 5],
    ]) {
      const res = await get(
        w.full,
        `/api/external/v1/transactions?cursor=${enc(c)}`,
      );
      expect(res.status, JSON.stringify(c)).toBe(400);
    }
  });

  it("lists the bills a payment is allocated to", async () => {
    const w = await world();
    const bill = await seedBill(w.a.id, { amount: minor(2000) });
    await allocate(w.a.id, bill.id, w.rows[0]!.id, minor(1000), "user");
    const { body } = await get(
      w.full,
      `/api/external/v1/transactions/${w.rows[0]!.id}`,
    );
    expect(body.billIds).toEqual([bill.id]);
    const list = await get(w.full, "/api/external/v1/transactions?limit=200");
    expect(
      list.body.items.find((i: Item) => i.id === w.rows[0]!.id)!.billIds,
    ).toEqual([bill.id]);
    expect(
      list.body.items.find((i: Item) => i.id === w.rows[1]!.id)!.billIds,
    ).toEqual([]);
    expect(await getDB().select().from(billAllocations)).toHaveLength(1);
  });

  it("a category-restricted token only sees transactions in those categories", async () => {
    const w = await world();
    const rentRows = w.rows
      .filter((_, i) => i % 3 === 0)
      .map((r) => r.id)
      .sort();
    const list = await get(
      w.restricted,
      "/api/external/v1/transactions?limit=200",
    );
    expect(list.body.items.map((i: Item) => i.id).sort()).toEqual(rentRows);
    expect(list.body.items.every((i: Item) => i.categoryId === w.rent.id)).toBe(
      true,
    );

    for (const [i, row] of w.rows.entries()) {
      const res = await get(
        w.restricted,
        `/api/external/v1/transactions/${row.id}`,
      );
      expect(res.status, `row ${i}`).toBe(i % 3 === 0 ? 200 : 404);
    }
    // asking for a category outside the restriction yields nothing, not a leak
    const other = await get(
      w.restricted,
      `/api/external/v1/transactions?categoryId=${w.sub.id}`,
    );
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ items: [], nextCursor: null });
    const inside = await get(
      w.restricted,
      `/api/external/v1/transactions?categoryId=${w.rent.id}&limit=200`,
    );
    expect(inside.body.items).toHaveLength(rentRows.length);
    // uncategorised rows are outside any restriction
    expect(list.body.items.some((i: Item) => i.categoryId === null)).toBe(
      false,
    );
    // pagination stays inside the restriction
    const paged = await collect(
      w.restricted,
      "/api/external/v1/transactions",
      1,
    );
    expect(paged.map((i) => i.id).sort()).toEqual(rentRows);
  });

  it("lists categories, restricted ones only for restricted tokens", async () => {
    const w = await world();
    const all = await get(w.full, "/api/external/v1/categories");
    expect(all.body.items.map((c: Item) => c.name)).toEqual([
      "Food",
      "Groceries",
      "Rent",
    ]);
    expect(Object.keys(all.body.items[0]).sort()).toEqual([
      "color",
      "id",
      "kind",
      "name",
      "parentId",
      "updatedAt",
    ]);
    expect(
      all.body.items.find((c: Item) => c.name === "Groceries")!.parentId,
    ).toBe(w.food.id);
    expect(all.body.items.map((c: Item) => c.id)).not.toContain(
      w.theirs.categoryId,
    );

    const restricted = await get(w.restricted, "/api/external/v1/categories");
    expect(restricted.body.items.map((c: Item) => c.id)).toEqual([w.rent.id]);
    const sub = await seedToken(w.a.id, ["categories:read"], {
      categoryIds: [w.sub.id],
    });
    const masked = await get(sub.token, "/api/external/v1/categories");
    expect(masked.body.items).toHaveLength(1);
    expect(masked.body.items[0]).toMatchObject({
      id: w.sub.id,
      parentId: null,
    });

    const theirs = await get(w.tokenB, "/api/external/v1/categories");
    expect(theirs.body.items.map((c: Item) => c.id)).toEqual([
      w.theirs.categoryId,
    ]);
  });

  it("paginates categories and honours updatedSince", async () => {
    const w = await world();
    const paged = await collect(w.full, "/api/external/v1/categories", 1);
    expect(paged.map((c) => c.name)).toEqual(["Food", "Groceries", "Rent"]);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      (await get(w.full, `/api/external/v1/categories?updatedSince=${future}`))
        .body.items,
    ).toEqual([]);
  });
});

describe("external API: accounts and recurring series", () => {
  useTestDB();

  it("lists accounts without IBANs or balances, for the owner only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const one = await seedAccount(a.id, {
      name: "Alpha",
      iban: EXAMPLE_IBAN,
      openingBalance: minor(123456),
      type: "savings",
      currency: "EUR",
    });
    await seedAccount(a.id, { name: "Beta", depositIban: EXAMPLE_IBAN_OTHER });
    const theirs = await seedAccount(b.id, { name: "Gamma" });
    const { token } = await seedToken(a.id, ["accounts:read"]);
    const { status, body } = await get(token, "/api/external/v1/accounts");
    expect(status).toBe(200);
    expect(body.items.map((x: Item) => x.name)).toEqual(["Alpha", "Beta"]);
    expect(body.items.map((x: Item) => x.id)).not.toContain(theirs.id);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "archived",
      "currency",
      "id",
      "name",
      "type",
      "updatedAt",
    ]);
    expect(body.items[0]).toMatchObject({
      id: one.id,
      currency: "EUR",
      type: "savings",
      archived: false,
    });
    expectNoLeak(body);
    expect(JSON.stringify(body)).not.toContain("123456");
    const paged = await collect(token, "/api/external/v1/accounts", 1);
    expect(paged.map((x) => x.name)).toEqual(["Alpha", "Beta"]);
  });

  async function series(
    userId: string,
    over: Partial<typeof recurringSeries.$inferInsert>,
  ) {
    return (
      await getDB()
        .insert(recurringSeries)
        .values({
          userId,
          key: `key-${crypto.randomUUID()}`,
          status: "confirmed",
          name: "Subscription",
          counterpartyIban: EXAMPLE_IBAN,
          cadence: "monthly",
          currency: "CHF",
          amount: minor(-1500),
          firstDate: "2026-01-05",
          lastDate: "2026-08-05",
          lastAmount: minor(-1500),
          occurrences: 8,
          ...over,
        })
        .returning()
    )[0]!;
  }

  it("lists recurring series without IBANs, filtered by status, for the owner only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const s1 = await series(a.id, { name: "Gym", status: "confirmed" });
    const s2 = await series(a.id, {
      name: "Paper",
      status: "suggested",
      cadence: "yearly",
      amount: minor(-12000),
      lastAmount: minor(-12000),
    });
    await series(a.id, { name: "Old", status: "dismissed" });
    const theirs = await series(b.id, { name: "Theirs" });
    const { token } = await seedToken(a.id, ["recurring:read"]);

    const all = await get(token, "/api/external/v1/recurring-series");
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);
    expect(all.body.items.map((x: Item) => x.id)).not.toContain(theirs.id);
    expect(Object.keys(all.body.items[0]).sort()).toEqual(
      [
        "amount",
        "annualCost",
        "cadence",
        "currency",
        "firstDate",
        "id",
        "lastAmount",
        "lastDate",
        "monthlyCost",
        "name",
        "nextExpected",
        "occurrences",
        "overdue",
        "status",
        "updatedAt",
      ].sort(),
    );
    expectNoLeak(all.body);
    const confirmed = await get(
      token,
      "/api/external/v1/recurring-series?status=confirmed",
    );
    expect(confirmed.body.items.map((x: Item) => x.id)).toEqual([s1.id]);
    expect(confirmed.body.items[0]).toMatchObject({
      name: "Gym",
      cadence: "monthly",
      amount: -1500,
      annualCost: -18000,
      monthlyCost: -1500,
      nextExpected: "2026-09-05",
    });
    const suggested = await get(
      token,
      "/api/external/v1/recurring-series?status=suggested",
    );
    expect(suggested.body.items.map((x: Item) => x.id)).toEqual([s2.id]);
    expect(
      (await get(token, "/api/external/v1/recurring-series?status=bogus"))
        .status,
    ).toBe(400);

    const paged = await collect(token, "/api/external/v1/recurring-series", 1);
    expect(paged).toHaveLength(3);
    expect(new Set(paged.map((x) => x.id)).size).toBe(3);
  });
});
