import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { minor } from "$lib/money";
import { fixed, parseFixed } from "$lib/quantity";
import { fxRates, securityPrices, trades } from "$lib/server/db";
import { parseForm } from "$lib/server/forms";
import { LedgerError } from "$lib/server/ledger";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  seedManualPrice,
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "$lib/testing/investments";
import { seedAccount } from "$lib/testing/ledger";
import {
  createSecurity,
  deletePrice,
  deleteSecurity,
  deleteTrade,
  getSecurity,
  getTrade,
  countPrices,
  isValidIsin,
  listPrices,
  PRICE_LIST_LIMIT,
  listSecurities,
  listTrades,
  priceInputSchema,
  securityInputSchema,
  setManualPrice,
  tradeInputSchema,
  updateSecurity,
  updateTrade,
  upsertFxRates,
  upsertProviderPrices,
  createTrade,
} from "./index";

const ctx = useTestDB();

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id);
  const security = seedSecurity(user.id);
  return { user, account, security };
}

function conflict(fn: () => unknown, message?: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe("conflict");
    if (message) expect((err as LedgerError).message).toMatch(message);
    return;
  }
  throw new Error("expected a LedgerError");
}

function notFoundError(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe("not_found");
    return;
  }
  throw new Error("expected a not_found LedgerError");
}

describe("securities", () => {
  it("creates, lists, updates and deletes", async () => {
    const { user } = await setup();
    const created = createSecurity(user.id, {
      name: "Zeta Fund",
      kind: "fund",
      isin: null,
      symbol: "ZETA.SW",
      currency: "CHF",
    });
    expect(listSecurities(user.id).map((s) => s.name)).toEqual([
      "Example World ETF",
      "Zeta Fund",
    ]);
    const updated = updateSecurity(user.id, created.id, {
      name: "Zeta Fund II",
      kind: "fund",
      isin: null,
      symbol: "ZETA.SW",
      currency: "CHF",
    });
    expect(updated.name).toBe("Zeta Fund II");
    deleteSecurity(user.id, created.id);
    notFoundError(() => getSecurity(user.id, created.id));
  });

  it("blocks delete while trades reference it, and cascades prices otherwise", async () => {
    const { user, account, security } = await setup();
    seedManualPrice(user.id, security.id, "2024-01-01", "100");
    const t = seedTrade(user.id, account.id, security.id, { amount: 1000 });
    conflict(() => deleteSecurity(user.id, security.id), /trades/);
    deleteTrade(user.id, t.id);
    deleteSecurity(user.id, security.id);
    expect(ctx.db.select().from(securityPrices).all()).toEqual([]);
  });

  it("blocks a currency change once trades exist", async () => {
    const { user, account, security } = await setup();
    const input = {
      name: security.name,
      kind: security.kind,
      isin: null,
      symbol: null,
      currency: "USD",
    };
    expect(updateSecurity(user.id, security.id, input).currency).toBe("USD");
    seedTrade(user.id, account.id, security.id, { amount: 1000 });
    conflict(() =>
      updateSecurity(user.id, security.id, { ...input, currency: "EUR" }),
    );
    expect(getSecurity(user.id, security.id).currency).toBe("USD");
  });

  it("blocks a currency change with manual prices but drops provider prices", async () => {
    const { user, security } = await setup();
    const input = {
      name: security.name,
      kind: security.kind,
      isin: null,
      symbol: null,
      currency: "USD",
    };
    seedProviderPrice(user.id, security.id, "2024-01-01", "100");
    const manual = seedManualPrice(user.id, security.id, "2024-01-02", "101");
    conflict(
      () => updateSecurity(user.id, security.id, input),
      /manual prices/,
    );
    deletePrice(user.id, manual.id);
    updateSecurity(user.id, security.id, input);
    expect(listPrices(user.id, security.id)).toEqual([]);
  });

  it("drops provider prices when the symbol changes and keeps manual ones", async () => {
    const { user, security } = await setup();
    seedProviderPrice(user.id, security.id, "2024-01-01", "100");
    seedManualPrice(user.id, security.id, "2024-01-02", "101");
    updateSecurity(user.id, security.id, {
      name: security.name,
      kind: security.kind,
      isin: null,
      symbol: "NEW.SW",
      currency: "CHF",
    });
    expect(listPrices(user.id, security.id).map((p) => p.source)).toEqual([
      "manual",
    ]);
  });

  it("is invisible to other users", async () => {
    const { user, security } = await setup();
    const other = await createTestUser();
    expect(listSecurities(other.id)).toEqual([]);
    notFoundError(() => getSecurity(other.id, security.id));
    notFoundError(() =>
      updateSecurity(other.id, security.id, {
        name: "x",
        kind: "etf",
        isin: null,
        symbol: null,
        currency: "CHF",
      }),
    );
    notFoundError(() => deleteSecurity(other.id, security.id));
    expect(getSecurity(user.id, security.id).name).toBe(security.name);
  });
});

describe("security form", () => {
  const valid = { name: "Example", kind: "etf", currency: "chf" };

  it("normalizes optional fields", () => {
    expect(parseForm(securityInputSchema, form(valid))).toMatchObject({
      ok: true,
      data: { isin: null, symbol: null, currency: "CHF" },
    });
    expect(
      parseForm(
        securityInputSchema,
        form({ ...valid, isin: " ie00b3rbwm25 ", symbol: "vwrl.sw" }),
      ),
    ).toMatchObject({
      ok: true,
      data: { isin: "IE00B3RBWM25", symbol: "VWRL.SW" },
    });
  });

  it.each([
    [{ ...valid, name: " " }, "name"],
    [{ ...valid, kind: "crypto" }, "kind"],
    [{ ...valid, isin: "123" }, "isin"],
    [{ ...valid, symbol: "a b" }, "symbol"],
    [{ ...valid, currency: "CHFF" }, "currency"],
  ])("rejects %j", (fields, field) => {
    const r = parseForm(securityInputSchema, form(fields));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });
});

describe("trade form", () => {
  const schema = tradeInputSchema("CHF");
  const valid = {
    securityId: "s",
    date: "2024-05-01",
    side: "buy",
    quantity: "2.5",
    price: "100,25",
    amount: "255.00",
  };

  it("parses quantity, price and amounts into fixed and minor units", () => {
    expect(parseForm(schema, form({ ...valid, fees: "4.5" }))).toMatchObject({
      ok: true,
      data: {
        quantity: parseFixed("2.5"),
        price: parseFixed("100.25"),
        fees: 450,
        amount: 25500,
        note: null,
      },
    });
    expect(parseForm(schema, form(valid))).toMatchObject({
      ok: true,
      data: { fees: 0 },
    });
  });

  it.each([
    [{ quantity: "0" }, "quantity"],
    [{ quantity: "-1" }, "quantity"],
    [{ quantity: "1.123456789" }, "quantity"],
    [{ price: "abc" }, "price"],
    [{ price: "0" }, "price"],
    [{ amount: "0" }, "amount"],
    [{ amount: "-5" }, "amount"],
    [{ amount: "1.234" }, "amount"],
    [{ fees: "-1" }, "fees"],
    [{ side: "hold" }, "side"],
    [{ date: "2024-02-30" }, "date"],
  ])("rejects %j", (patch, field) => {
    const r = parseForm(schema, form({ ...valid, ...patch }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });

  it("parses a split with only a ratio", () => {
    const parsed = parseForm(
      schema,
      form({
        securityId: "s",
        date: "2024-05-01",
        side: "split",
        quantity: "0.1",
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      data: {
        side: "split",
        quantity: parseFixed("0.1"),
        price: 0,
        fees: 0,
        amount: 0,
      },
    });
    // price and amount sent along are ignored
    expect(
      parseForm(schema, form({ ...valid, side: "split", quantity: "2" })),
    ).toMatchObject({ ok: true, data: { price: 0, amount: 0 } });
    expect(
      parseForm(schema, form({ ...valid, side: "split", quantity: "0" })).ok,
    ).toBe(false);
  });

  it("rejects an unknown side", () => {
    const r = parseForm(schema, form({ ...valid, side: "gift" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.side?.[0]).toMatch(/buy, sell or split/);
  });

  it("uses the account currency's exponent", () => {
    expect(
      parseForm(tradeInputSchema("JPY"), form({ ...valid, amount: "255" })),
    ).toMatchObject({ ok: true, data: { amount: 255 } });
    expect(
      parseForm(tradeInputSchema("JPY"), form({ ...valid, amount: "255.5" }))
        .ok,
    ).toBe(false);
  });
});

describe("price form", () => {
  it("requires a positive price", () => {
    expect(
      parseForm(priceInputSchema, form({ date: "2024-01-01", price: "12.5" })),
    ).toMatchObject({ ok: true, data: { price: parseFixed("12.5") } });
    expect(
      parseForm(priceInputSchema, form({ date: "2024-01-01", price: "0" })).ok,
    ).toBe(false);
  });
});

describe("isin", () => {
  it("accepts documented example ISINs and rejects a wrong check digit", () => {
    for (const isin of ["US0378331005", "IE00B3RBWM25", "ie00b3rbwm25"]) {
      expect(isValidIsin(isin.toUpperCase())).toBe(true);
      expect(
        securityInputSchema.safeParse({
          name: "X",
          kind: "etf",
          isin,
          symbol: "",
          currency: "CHF",
        }).success,
      ).toBe(true);
    }
    for (const isin of ["US0378331006", "IE00B3RBWM24", "US037833100"]) {
      expect(isValidIsin(isin)).toBe(false);
    }
    expect(
      securityInputSchema.safeParse({
        name: "X",
        kind: "etf",
        isin: "US0378331006",
        symbol: "",
        currency: "CHF",
      }).success,
    ).toBe(false);
  });
});

describe("trades", () => {
  it("creates and lists newest first with security details", async () => {
    const { user, account, security } = await setup();
    seedTrade(user.id, account.id, security.id, {
      date: "2024-01-01",
      amount: 1005,
      fees: 5,
      note: "first",
    });
    const second = seedTrade(user.id, account.id, security.id, {
      date: "2024-02-01",
      amount: 2000,
      qty: "20",
    });
    const list = listTrades(user.id, account.id);
    expect(list.map((t) => t.date)).toEqual(["2024-02-01", "2024-01-01"]);
    expect(list[1]).toMatchObject({
      securityName: security.name,
      securityCurrency: "CHF",
      fees: 5,
      amount: 1005,
      note: "first",
      quantity: parseFixed("10"),
      price: parseFixed("100"),
    });
    expect(getTrade(user.id, second.id).side).toBe("buy");
  });

  it("rejects an oversell on create and leaves nothing behind", async () => {
    const { user, account, security } = await setup();
    seedTrade(user.id, account.id, security.id, { amount: 1000 });
    conflict(
      () =>
        seedTrade(user.id, account.id, security.id, {
          side: "sell",
          qty: "10.00000001",
          amount: 1000,
        }),
      /negative holding/,
    );
    expect(listTrades(user.id, account.id)).toHaveLength(1);
    seedTrade(user.id, account.id, security.id, {
      side: "sell",
      qty: "10",
      amount: 1000,
      date: "2024-02-01",
    });
  });

  describe("splits", () => {
    const splitOf = (
      userId: string,
      accountId: string,
      securityId: string,
      date: string,
      ratio: string,
    ) =>
      seedTrade(userId, accountId, securityId, {
        date,
        side: "split",
        qty: ratio,
        price: "0",
        amount: 0,
      });

    it("records a split and lets a later sell use the split quantity", async () => {
      const { user, account, security } = await setup();
      seedTrade(user.id, account.id, security.id, { amount: 1000 });
      const s = splitOf(user.id, account.id, security.id, "2024-02-01", "2");
      expect(s).toMatchObject({
        side: "split",
        quantity: parseFixed("2"),
        price: 0,
        amount: 0,
      });
      seedTrade(user.id, account.id, security.id, {
        date: "2024-03-01",
        side: "sell",
        qty: "20",
        amount: 2000,
      });
      conflict(
        () =>
          seedTrade(user.id, account.id, security.id, {
            date: "2024-04-01",
            side: "sell",
            qty: "0.00000001",
            amount: 1,
          }),
        /negative holding/,
      );
    });

    it("rejects a sell that was only valid before a reverse split", async () => {
      const { user, account, security } = await setup();
      seedTrade(user.id, account.id, security.id, { amount: 1000 });
      seedTrade(user.id, account.id, security.id, {
        date: "2024-03-01",
        side: "sell",
        qty: "5",
        amount: 500,
      });
      conflict(
        () => splitOf(user.id, account.id, security.id, "2024-02-01", "0.1"),
        /negative holding/,
      );
      expect(listTrades(user.id, account.id)).toHaveLength(2);
    });

    it("rejects a split without shares and deleting the buy under a split", async () => {
      const { user, account, security } = await setup();
      conflict(
        () => splitOf(user.id, account.id, security.id, "2024-01-01", "2"),
        /no shares to split/,
      );
      const buy = seedTrade(user.id, account.id, security.id, { amount: 1000 });
      splitOf(user.id, account.id, security.id, "2024-02-01", "2");
      conflict(() => deleteTrade(user.id, buy.id), /no shares to split/);
    });

    it("rejects deleting a split that later sells depend on", async () => {
      const { user, account, security } = await setup();
      seedTrade(user.id, account.id, security.id, { amount: 1000 });
      const s = splitOf(user.id, account.id, security.id, "2024-02-01", "2");
      seedTrade(user.id, account.id, security.id, {
        date: "2024-03-01",
        side: "sell",
        qty: "15",
        amount: 1500,
      });
      conflict(() => deleteTrade(user.id, s.id), /negative holding/);
    });

    it("rejects a ratio that overflows the quantity", async () => {
      const { user, account, security } = await setup();
      seedTrade(user.id, account.id, security.id, {
        qty: "50000000",
        amount: 1000,
      });
      expect(() =>
        splitOf(user.id, account.id, security.id, "2024-02-01", "100"),
      ).toThrow(/too large/);
    });

    it("never touches another user's trades", async () => {
      const a = await setup();
      const b = await setup();
      seedTrade(a.user.id, a.account.id, a.security.id, { amount: 1000 });
      expect(() =>
        splitOf(b.user.id, a.account.id, a.security.id, "2024-02-01", "2"),
      ).toThrow(LedgerError);
      expect(listTrades(a.user.id, a.account.id)).toHaveLength(1);
    });
  });

  it("rejects selling before buying", async () => {
    const { user, account, security } = await setup();
    seedTrade(user.id, account.id, security.id, {
      date: "2024-02-01",
      amount: 1000,
    });
    conflict(() =>
      seedTrade(user.id, account.id, security.id, {
        date: "2024-01-01",
        side: "sell",
        qty: "1",
        amount: 100,
      }),
    );
  });

  it("counts a buy of the same date before a sell", async () => {
    const { user, account, security } = await setup();
    seedTrade(user.id, account.id, security.id, { amount: 1000 });
    seedTrade(user.id, account.id, security.id, {
      date: "2024-03-01",
      qty: "5",
      amount: 500,
    });
    seedTrade(user.id, account.id, security.id, {
      date: "2024-03-01",
      side: "sell",
      qty: "15",
      amount: 1500,
    });
    expect(listTrades(user.id, account.id)).toHaveLength(3);
  });

  it("rejects an edit that shrinks an earlier buy below later sells", async () => {
    const { user, account, security } = await setup();
    const buy = seedTrade(user.id, account.id, security.id, { amount: 1000 });
    seedTrade(user.id, account.id, security.id, {
      date: "2024-02-01",
      side: "sell",
      qty: "8",
      amount: 800,
    });
    const input = {
      securityId: security.id,
      date: buy.date,
      side: buy.side,
      quantity: parseFixed("7"),
      price: buy.price,
      fees: minor(0),
      amount: buy.amount,
      note: null,
    };
    conflict(() => updateTrade(user.id, buy.id, input), /2024-02-01/);
    expect(getTrade(user.id, buy.id).quantity).toBe(parseFixed("10"));
    expect(
      updateTrade(user.id, buy.id, { ...input, quantity: parseFixed("9") })
        .quantity,
    ).toBe(parseFixed("9"));
  });

  it("rejects an edit that moves a buy after its sell", async () => {
    const { user, account, security } = await setup();
    const buy = seedTrade(user.id, account.id, security.id, { amount: 1000 });
    seedTrade(user.id, account.id, security.id, {
      date: "2024-02-01",
      side: "sell",
      qty: "5",
      amount: 500,
    });
    conflict(() =>
      updateTrade(user.id, buy.id, {
        securityId: security.id,
        date: "2024-03-01",
        side: "buy",
        quantity: buy.quantity,
        price: buy.price,
        fees: minor(0),
        amount: buy.amount,
        note: null,
      }),
    );
  });

  it("rejects deleting a buy that later sells depend on", async () => {
    const { user, account, security } = await setup();
    const buy = seedTrade(user.id, account.id, security.id, { amount: 1000 });
    const sell = seedTrade(user.id, account.id, security.id, {
      date: "2024-02-01",
      side: "sell",
      qty: "5",
      amount: 500,
    });
    conflict(() => deleteTrade(user.id, buy.id));
    expect(listTrades(user.id, account.id)).toHaveLength(2);
    deleteTrade(user.id, sell.id);
    deleteTrade(user.id, buy.id);
    expect(listTrades(user.id, account.id)).toEqual([]);
  });

  it("validates both securities when a trade changes security", async () => {
    const { user, account, security } = await setup();
    const other = seedSecurity(user.id, { name: "Other" });
    const buy = seedTrade(user.id, account.id, security.id, { amount: 1000 });
    seedTrade(user.id, account.id, security.id, {
      date: "2024-02-01",
      side: "sell",
      qty: "5",
      amount: 500,
    });
    const input = {
      securityId: other.id,
      date: buy.date,
      side: buy.side,
      quantity: buy.quantity,
      price: buy.price,
      fees: minor(0),
      amount: buy.amount,
      note: null,
    };
    conflict(() => updateTrade(user.id, buy.id, input));

    const lone = seedTrade(user.id, account.id, other.id, {
      date: "2024-03-01",
      amount: 100,
    });
    expect(
      updateTrade(user.id, lone.id, { ...input, securityId: security.id })
        .securityId,
    ).toBe(security.id);
  });

  it("keeps sequences per account and per security", async () => {
    const { user, account, security } = await setup();
    const second = seedAccount(user.id, { name: "Second" });
    const other = seedSecurity(user.id, { name: "Other" });
    seedTrade(user.id, account.id, security.id, { amount: 1000 });
    conflict(() =>
      seedTrade(user.id, second.id, security.id, {
        side: "sell",
        qty: "1",
        amount: 100,
      }),
    );
    conflict(() =>
      seedTrade(user.id, account.id, other.id, {
        side: "sell",
        qty: "1",
        amount: 100,
      }),
    );
  });

  it("cascades with the account", async () => {
    const { user, account, security } = await setup();
    seedTrade(user.id, account.id, security.id, { amount: 1000 });
    const { deleteAccount } = await import("$lib/server/ledger");
    deleteAccount(user.id, account.id);
    expect(ctx.db.select().from(trades).all()).toEqual([]);
  });

  it("hides trades, accounts and securities of other users", async () => {
    const { user, account, security } = await setup();
    const trade = seedTrade(user.id, account.id, security.id, { amount: 1000 });
    const other = await createTestUser();
    const otherAccount = seedAccount(other.id);
    const otherSecurity = seedSecurity(other.id);
    const input = {
      securityId: security.id,
      date: "2024-02-01",
      side: "buy" as const,
      quantity: fixed(100_000_000),
      price: fixed(100_000_000),
      fees: minor(0),
      amount: minor(100),
      note: null,
    };

    notFoundError(() => listTrades(other.id, account.id));
    notFoundError(() => getTrade(other.id, trade.id));
    notFoundError(() => deleteTrade(other.id, trade.id));
    notFoundError(() => updateTrade(other.id, trade.id, input));
    notFoundError(() =>
      createTrade(other.id, account.id, {
        ...input,
        securityId: otherSecurity.id,
      }),
    );
    notFoundError(() => createTrade(other.id, otherAccount.id, input));
    notFoundError(() =>
      updateTrade(user.id, trade.id, {
        ...input,
        securityId: otherSecurity.id,
      }),
    );
    expect(listTrades(user.id, account.id)).toHaveLength(1);
    expect(listTrades(other.id, otherAccount.id)).toEqual([]);
  });
});

describe("prices", () => {
  it("sets, replaces and deletes manual prices", async () => {
    const { user, security } = await setup();
    const first = setManualPrice(user.id, security.id, {
      date: "2024-01-01",
      price: parseFixed("100"),
    });
    const replaced = setManualPrice(user.id, security.id, {
      date: "2024-01-01",
      price: parseFixed("101.5"),
    });
    expect(replaced.id).toBe(first.id);
    expect(replaced).toMatchObject({
      price: parseFixed("101.5"),
      source: "manual",
    });
    expect(listPrices(user.id, security.id)).toHaveLength(1);
    deletePrice(user.id, first.id);
    expect(listPrices(user.id, security.id)).toEqual([]);
  });

  it("skips zero and negative provider prices", async () => {
    const { user, security } = await setup();
    const n = upsertProviderPrices(user.id, security.id, [
      { date: "2024-01-01", price: parseFixed("0") },
      { date: "2024-01-02", price: parseFixed("-3") },
      { date: "2024-01-03", price: parseFixed("3") },
    ]);
    expect(n).toBe(1);
    expect(listPrices(user.id, security.id).map((p) => p.date)).toEqual([
      "2024-01-03",
    ]);
  });

  it("limits the price list to the newest rows and counts them all", async () => {
    const { user, security } = await setup();
    upsertProviderPrices(
      user.id,
      security.id,
      Array.from({ length: 400 }, (_, i) => ({
        date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10),
        price: parseFixed("1"),
      })),
    );
    const list = listPrices(user.id, security.id);
    expect(list).toHaveLength(PRICE_LIST_LIMIT);
    expect(list[0]!.date > list[1]!.date).toBe(true);
    expect(countPrices(user.id, security.id)).toBe(400);
    expect(listPrices(user.id, security.id, 1000)).toHaveLength(400);
    const other = await createTestUser();
    notFoundError(() => countPrices(other.id, security.id));
    notFoundError(() => listPrices(other.id, security.id));
  });

  it("keeps a manual and a provider price of the same date side by side", async () => {
    const { user, security } = await setup();
    seedProviderPrice(user.id, security.id, "2024-01-01", "100");
    seedManualPrice(user.id, security.id, "2024-01-01", "101");
    seedProviderPrice(user.id, security.id, "2024-01-02", "102");
    expect(
      listPrices(user.id, security.id).map((p) => [p.date, p.source]),
    ).toEqual([
      ["2024-01-02", "provider"],
      ["2024-01-01", "provider"],
      ["2024-01-01", "manual"],
    ]);
  });

  it("refuses to delete provider prices", async () => {
    const { user, security } = await setup();
    seedProviderPrice(user.id, security.id, "2024-01-01", "100");
    const [price] = listPrices(user.id, security.id);
    conflict(() => deletePrice(user.id, price!.id));
  });

  it("upserts provider prices without touching manual ones", async () => {
    const { user, security } = await setup();
    seedManualPrice(user.id, security.id, "2024-01-01", "101");
    upsertProviderPrices(user.id, security.id, [
      { date: "2024-01-01", price: parseFixed("100") },
      { date: "2024-01-02", price: parseFixed("102") },
    ]);
    upsertProviderPrices(user.id, security.id, [
      { date: "2024-01-02", price: parseFixed("103") },
    ]);
    const prices = listPrices(user.id, security.id);
    expect(prices).toHaveLength(3);
    expect(prices.find((p) => p.date === "2024-01-02")!.price).toBe(
      parseFixed("103"),
    );
    expect(
      prices.find((p) => p.date === "2024-01-01" && p.source === "manual")!
        .price,
    ).toBe(parseFixed("101"));
  });

  it("upserts many rows across statement chunks", async () => {
    const { user, security } = await setup();
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      price: fixed(100_000_000 + i),
    }));
    expect(upsertProviderPrices(user.id, security.id, rows)).toBe(1200);
    expect(listPrices(user.id, security.id, 5000)).toHaveLength(1200);
  });

  it("upserts FX rates idempotently", async () => {
    const user = await createTestUser();
    const row = {
      base: "USD",
      quote: "CHF",
      date: "2024-01-01",
      rate: parseFixed("0.9"),
    };
    upsertFxRates(user.id, [row]);
    upsertFxRates(user.id, [{ ...row, rate: parseFixed("0.91") }]);
    const rows = ctx.db
      .select()
      .from(fxRates)
      .where(eq(fxRates.userId, user.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rate).toBe(parseFixed("0.91"));
  });

  it("hides and protects the prices of other users", async () => {
    const { user, security } = await setup();
    const price = seedManualPrice(user.id, security.id, "2024-01-01", "100");
    const other = await createTestUser();
    notFoundError(() => listPrices(other.id, security.id));
    notFoundError(() =>
      setManualPrice(other.id, security.id, {
        date: "2024-01-02",
        price: parseFixed("1"),
      }),
    );
    notFoundError(() =>
      upsertProviderPrices(other.id, security.id, [
        { date: "2024-01-02", price: parseFixed("1") },
      ]),
    );
    notFoundError(() => deletePrice(other.id, price.id));
    expect(listPrices(user.id, security.id)).toHaveLength(1);
  });
});
