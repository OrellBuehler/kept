import { afterEach, describe, expect, it } from "vitest";
import { API_SCOPES } from "$lib/api-tokens";
import { allocate } from "$lib/server/bills/allocations";
import { minor } from "$lib/money";
import {
  apiAuthFailureLimiter,
  apiTokenLimiter,
} from "$lib/server/external-api/gate";
import { useTestDB } from "$lib/testing/db";
import { callApi, seedToken, type Body } from "$lib/testing/external-api";
import { buildWorld } from "$lib/testing/mcp-world";

afterEach(() => {
  apiTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

const ALL = [...API_SCOPES];

async function get(token: string, path: string) {
  const res = await callApi(token, path);
  return { status: res.status, body: (await res.json()) as Body };
}

describe("external API: account restriction", () => {
  useTestDB();

  it("lists and reads only transactions of its accounts", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ALL, {
      accountIds: [w.checking.id],
    });
    const list = await get(token, "/api/external/v1/transactions");
    expect(list.body.items.map((i) => i.id)).toEqual([
      w.t5.id,
      w.t2.id,
      w.t1.id,
    ]);
    expect(
      (await get(token, `/api/external/v1/transactions/${w.t3.id}`)).status,
    ).toBe(404);
    expect(
      (await get(token, `/api/external/v1/transactions/${w.t1.id}`)).status,
    ).toBe(200);
    const other = await get(
      token,
      `/api/external/v1/transactions?accountId=${w.savings.id}`,
    );
    expect(other.body.items).toEqual([]);
  });

  it("lists only its accounts", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ALL, {
      accountIds: [w.savings.id],
    });
    const list = await get(token, "/api/external/v1/accounts");
    expect(list.body.items.map((i) => i.id)).toEqual([w.savings.id]);
  });

  it("answers 404 for links on a payment of another account, in both directions", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(
      w.a.id,
      ["links:write", "transactions:read"],
      {
        accountIds: [w.checking.id],
      },
    );
    const body = { source: "app", label: "Open", url: "https://example.org/x" };
    const hidden = await callApi(
      token,
      `/api/external/v1/transactions/${w.t3.id}/links`,
      { method: "POST", body },
    );
    expect(hidden.status).toBe(404);
    const visible = await callApi(
      token,
      `/api/external/v1/transactions/${w.t1.id}/links`,
      { method: "POST", body },
    );
    expect(visible.status).toBe(201);
    const full = await seedToken(w.a.id, ["links:write"]);
    const created = await callApi(
      full.token,
      `/api/external/v1/transactions/${w.t3.id}/links`,
      { method: "POST", body },
    );
    const link = (await created.json()) as { id: string };
    const removal = await callApi(token, `/api/external/v1/links/${link.id}`, {
      method: "DELETE",
    });
    expect(removal.status).toBe(404);
  });

  it("refuses recurring series, as it does for categories", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ["recurring:read"], {
      accountIds: [w.checking.id],
    });
    expect((await get(token, "/api/external/v1/recurring-series")).status).toBe(
      403,
    );
  });

  it("describes the account restriction on /me", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ["bills:read"], {
      accountIds: [w.checking.id],
    });
    const me = await get(token, "/api/external/v1/me");
    expect(me.body.token).toEqual({
      scopes: ["bills:read"],
      categoryIds: null,
      accountIds: [w.checking.id],
    });
  });

  it("combines with a category restriction", async () => {
    const w = await buildWorld();
    const { token } = await seedToken(w.a.id, ["transactions:read"], {
      accountIds: [w.savings.id],
      categoryIds: [w.food.id],
    });
    const list = await get(token, "/api/external/v1/transactions");
    expect(list.body.items.map((i) => i.id)).toEqual([w.t3.id]);
  });

  it("leaves bills readable, with paidAmount counting payments of every account", async () => {
    const w = await buildWorld();
    await allocate(w.a.id, w.bill1.id, w.t4.id, minor(700), "user");
    const { token } = await seedToken(w.a.id, ["bills:read"], {
      accountIds: [w.checking.id],
    });
    const bill = await get(token, `/api/external/v1/bills/${w.bill1.id}`);
    expect(bill.status).toBe(200);
    expect(bill.body.paidAmount).toBe(700);
  });
});

describe("external API: new transaction filters and bill search", () => {
  useTestDB();

  it("filters uncategorized and unmatched payments and searches bills", async () => {
    const w = await buildWorld();
    await allocate(w.a.id, w.bill1.id, w.t2.id, minor(10000), "user");
    const { token } = await seedToken(w.a.id, ALL);
    const ids = async (q: string) =>
      (await get(token, `/api/external/v1/transactions?${q}`)).body.items.map(
        (i) => i.id,
      );
    expect(await ids("uncategorized=true")).toEqual([w.t5.id, w.t4.id]);
    expect(await ids("uncategorized=false")).toEqual([
      w.t3.id,
      w.t2.id,
      w.t1.id,
    ]);
    expect(await ids("unmatched=false")).toEqual([w.t2.id]);
    expect(await ids("unmatched=true")).toEqual([
      w.t5.id,
      w.t4.id,
      w.t3.id,
      w.t1.id,
    ]);
    expect(
      (await get(token, "/api/external/v1/transactions?unmatched=maybe"))
        .status,
    ).toBe(400);
    const bills = await get(token, "/api/external/v1/bills?q=second");
    expect(bills.body.items.map((i) => i.id)).toEqual([w.bill2.id]);
  });
});
