import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { parseFixed } from "$lib/quantity";
import {
  firstOversell,
  holdingsValueAt,
  makeHoldingsValueAt,
  type HoldingsInput,
  type HoldingTrade,
} from "./valuation";

const f = parseFixed;

const etf = { id: "s1", name: "Alpha ETF", currency: "CHF" };
const usd = { id: "s2", name: "Beta Stock", currency: "USD" };

function trade(
  over: Partial<HoldingTrade> & Pick<HoldingTrade, "date" | "amount">,
): HoldingTrade {
  return {
    securityId: "s1",
    side: "buy",
    quantity: f("10"),
    price: f("100"),
    ...over,
  };
}

function input(over: Partial<HoldingsInput> = {}): HoldingsInput {
  return {
    accountCurrency: "CHF",
    securities: [etf, usd],
    trades: [],
    prices: [],
    fx: [],
    ...over,
  };
}

describe("holdings valuation", () => {
  it("is empty without trades", () => {
    expect(holdingsValueAt(input(), "2024-12-31")).toEqual({
      value: 0,
      cost: 0,
      positions: [],
      estimated: false,
    });
  });

  it("counts nothing before the first trade and a trade on its own day", () => {
    const i = input({ trades: [trade({ date: "2024-03-01", amount: 1005 })] });
    const at = makeHoldingsValueAt(i);
    expect(at("2024-02-29").positions).toEqual([]);
    expect(at("2024-03-01").value).toBe(100000);
  });

  it("values at the latest price on or before the date", () => {
    const i = input({
      trades: [trade({ date: "2024-01-01", amount: 100000 })],
      prices: [
        {
          securityId: "s1",
          date: "2024-01-10",
          price: f("110"),
          source: "provider",
        },
        {
          securityId: "s1",
          date: "2024-01-20",
          price: f("120"),
          source: "provider",
        },
      ],
    });
    const at = makeHoldingsValueAt(i);
    expect(at("2024-01-09").positions[0]).toMatchObject({
      priceSource: "trade",
      value: 100000,
    });
    expect(at("2024-01-15").positions[0]).toMatchObject({
      price: f("110"),
      priceDate: "2024-01-10",
      priceSource: "provider",
      value: 110000,
      cost: 100000,
      gain: 10000,
      estimated: false,
    });
    expect(at("2024-02-01").value).toBe(120000);
  });

  it("lets a manual price win over a provider price on the same date", () => {
    const i = input({
      trades: [trade({ date: "2024-01-01", amount: 100000 })],
      prices: [
        {
          securityId: "s1",
          date: "2024-01-10",
          price: f("110"),
          source: "manual",
        },
        {
          securityId: "s1",
          date: "2024-01-10",
          price: f("111"),
          source: "provider",
        },
      ],
    });
    expect(holdingsValueAt(i, "2024-01-10").positions[0]).toMatchObject({
      price: f("110"),
      priceSource: "manual",
    });
    const reversed = input({ ...i, prices: [...i.prices].reverse() });
    expect(holdingsValueAt(reversed, "2024-01-10").positions[0]!.price).toBe(
      f("110"),
    );
  });

  it("does not let a newer provider price lose to an older manual one", () => {
    const i = input({
      trades: [trade({ date: "2024-01-01", amount: 100000 })],
      prices: [
        {
          securityId: "s1",
          date: "2024-01-05",
          price: f("105"),
          source: "manual",
        },
        {
          securityId: "s1",
          date: "2024-01-10",
          price: f("110"),
          source: "provider",
        },
      ],
    });
    expect(holdingsValueAt(i, "2024-01-10").value).toBe(110000);
  });

  it("falls back to the trade price when a trade is newer than every price", () => {
    const i = input({
      trades: [
        trade({ date: "2024-01-01", amount: 100000 }),
        trade({ date: "2024-02-01", amount: 130000, price: f("130") }),
      ],
      prices: [
        {
          securityId: "s1",
          date: "2024-01-10",
          price: f("110"),
          source: "provider",
        },
      ],
    });
    const at = makeHoldingsValueAt(i);
    expect(at("2024-01-31").positions[0]!.priceSource).toBe("provider");
    expect(at("2024-02-01").positions[0]).toMatchObject({
      priceSource: "trade",
      price: f("130"),
      quantity: f("20"),
      value: 260000,
    });
  });

  it("ignores prices after the date", () => {
    const i = input({
      trades: [trade({ date: "2024-01-01", amount: 100000 })],
      prices: [
        {
          securityId: "s1",
          date: "2024-06-01",
          price: f("999"),
          source: "provider",
        },
      ],
    });
    expect(holdingsValueAt(i, "2024-05-31").value).toBe(100000);
  });

  it("uses the average cost method across buys and sells", () => {
    const i = input({
      trades: [
        trade({ date: "2024-01-01", amount: 100000 }),
        trade({ date: "2024-02-01", amount: 120000, price: f("120") }),
        trade({
          date: "2024-03-01",
          side: "sell",
          quantity: f("5"),
          price: f("150"),
          amount: 75000,
        }),
      ],
      prices: [
        {
          securityId: "s1",
          date: "2024-03-10",
          price: f("160"),
          source: "provider",
        },
      ],
    });
    const at = makeHoldingsValueAt(i);
    expect(at("2024-02-15").positions[0]).toMatchObject({
      quantity: f("20"),
      cost: 220000,
    });
    expect(at("2024-03-10").positions[0]).toMatchObject({
      quantity: f("15"),
      cost: 165000,
      value: 240000,
      gain: 75000,
    });
  });

  it("removes a position that was sold completely and its basis", () => {
    const i = input({
      trades: [
        trade({ date: "2024-01-01", amount: 100000 }),
        trade({ date: "2024-02-01", side: "sell", amount: 120000 }),
        trade({
          date: "2024-03-01",
          amount: 50000,
          quantity: f("4"),
          price: f("125"),
        }),
      ],
    });
    const at = makeHoldingsValueAt(i);
    expect(at("2024-02-15")).toMatchObject({
      value: 0,
      cost: 0,
      positions: [],
    });
    expect(at("2024-03-01").positions[0]).toMatchObject({
      quantity: f("4"),
      cost: 50000,
    });
  });

  it("applies buys before sells on the same date", () => {
    const i = input({
      trades: [
        trade({ date: "2024-01-01", side: "sell", amount: 100000 }),
        trade({ date: "2024-01-01", amount: 100000 }),
      ],
    });
    expect(holdingsValueAt(i, "2024-01-01").positions).toEqual([]);
  });

  it("rounds the remaining basis half away from zero", () => {
    const i = input({
      trades: [
        trade({ date: "2024-01-01", amount: 100, quantity: f("3") }),
        trade({
          date: "2024-01-02",
          side: "sell",
          quantity: f("1"),
          amount: 40,
        }),
      ],
    });
    expect(holdingsValueAt(i, "2024-01-02").positions[0]!.cost).toBe(67);
  });

  it("sums several securities and sorts positions by name", () => {
    const i = input({
      trades: [
        trade({
          securityId: "s2",
          date: "2024-01-01",
          amount: 1,
          price: f("1"),
        }),
        trade({ date: "2024-01-01", amount: 100000 }),
      ],
      fx: [{ base: "USD", quote: "CHF", date: "2024-01-01", rate: f("0.9") }],
    });
    const v = holdingsValueAt(i, "2024-01-01");
    expect(v.positions.map((p) => p.name)).toEqual(["Alpha ETF", "Beta Stock"]);
    expect(v.value).toBe(100000 + 900);
    expect(v.cost).toBe(100001);
  });

  describe("foreign currency", () => {
    const base = {
      trades: [
        trade({
          securityId: "s2",
          date: "2024-01-01",
          quantity: f("10"),
          price: f("100"),
          amount: 90000,
        }),
      ],
      prices: [
        {
          securityId: "s2",
          date: "2024-01-05",
          price: f("110"),
          source: "provider",
        },
      ],
    };

    it("converts with the latest direct rate on or before the date", () => {
      const i = input({
        ...base,
        fx: [
          { base: "USD", quote: "CHF", date: "2024-01-01", rate: f("0.9") },
          { base: "USD", quote: "CHF", date: "2024-01-04", rate: f("0.8") },
          { base: "USD", quote: "CHF", date: "2024-01-09", rate: f("0.5") },
        ],
      });
      expect(holdingsValueAt(i, "2024-01-05").positions[0]).toMatchObject({
        value: 88000,
        fxRate: f("0.8"),
        estimated: false,
        gain: -2000,
      });
    });

    it("falls back to the inverse pair", () => {
      const i = input({
        ...base,
        fx: [
          { base: "CHF", quote: "USD", date: "2024-01-01", rate: f("1.25") },
        ],
      });
      const p = holdingsValueAt(i, "2024-01-05").positions[0]!;
      expect(p.value).toBe(88000);
      expect(p.fxRate).toBe(f("0.8"));
      expect(p.estimated).toBe(false);
    });

    it("prefers whichever pair has the newer rate", () => {
      const i = input({
        ...base,
        fx: [
          { base: "USD", quote: "CHF", date: "2024-01-01", rate: f("0.9") },
          { base: "CHF", quote: "USD", date: "2024-01-03", rate: f("1.25") },
        ],
      });
      expect(holdingsValueAt(i, "2024-01-05").value).toBe(88000);
    });

    it("values at cost and flags estimated when no rate exists", () => {
      const i = input({
        ...base,
        fx: [{ base: "USD", quote: "CHF", date: "2024-02-01", rate: f("0.9") }],
      });
      const v = holdingsValueAt(i, "2024-01-05");
      expect(v.estimated).toBe(true);
      expect(v.value).toBe(90000);
      expect(v.positions[0]).toMatchObject({
        estimated: true,
        fxRate: null,
        value: 90000,
        gain: 0,
      });
      expect(holdingsValueAt(i, "2024-02-01").estimated).toBe(false);
    });

    it("ignores non-positive rates", () => {
      const i = input({
        ...base,
        fx: [{ base: "USD", quote: "CHF", date: "2024-01-01", rate: f("0") }],
      });
      expect(holdingsValueAt(i, "2024-01-05").estimated).toBe(true);
    });

    it("uses the account currency's minor-unit exponent", () => {
      const i = input({
        accountCurrency: "JPY",
        securities: [{ id: "s2", name: "Beta Stock", currency: "USD" }],
        ...base,
        fx: [{ base: "USD", quote: "JPY", date: "2024-01-01", rate: f("150") }],
      });
      expect(holdingsValueAt(i, "2024-01-05").value).toBe(165000);
    });
  });
});

describe("firstOversell", () => {
  const t = (date: string, side: "buy" | "sell", q: string) => ({
    date,
    side,
    quantity: f(q),
  });

  it("returns null for a valid sequence", () => {
    expect(
      firstOversell([
        t("2024-01-01", "buy", "5"),
        t("2024-01-02", "sell", "5"),
      ]),
    ).toBeNull();
  });

  it("returns the date the holding turns negative", () => {
    expect(
      firstOversell([
        t("2024-03-01", "sell", "6"),
        t("2024-01-01", "buy", "5"),
        t("2024-02-01", "buy", "0.5"),
      ]),
    ).toBe("2024-03-01");
  });

  it("applies buys first on the same date", () => {
    expect(
      firstOversell([
        t("2024-01-01", "sell", "1"),
        t("2024-01-01", "buy", "1"),
      ]),
    ).toBeNull();
  });
});

describe("cost values are Minor", () => {
  it("returns integers", () => {
    const i = input({ trades: [trade({ date: "2024-01-01", amount: 1 })] });
    expect(Number.isInteger(holdingsValueAt(i, "2024-01-01").value)).toBe(true);
    expect(minor(holdingsValueAt(i, "2024-01-01").cost)).toBe(1);
  });
});
