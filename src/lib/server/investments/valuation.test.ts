import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { parseFixed } from "$lib/quantity";
import {
  firstEmptySplit,
  firstOversell,
  heldQuantity,
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

describe("stock splits", () => {
  const split = (date: string, ratio: string, over = {}): HoldingTrade =>
    trade({
      date,
      side: "split",
      quantity: f(ratio),
      price: f("0"),
      amount: 0,
      ...over,
    });
  const buy10 = trade({ date: "2024-01-01", amount: 100000 });

  it("multiplies the quantity on the split date and keeps the cost basis", () => {
    const at = makeHoldingsValueAt(
      input({ trades: [buy10, split("2024-06-01", "2")] }),
    );
    expect(at("2024-05-31").positions[0]).toMatchObject({
      quantity: f("10"),
      cost: 100000,
      price: f("100"),
    });
    expect(at("2024-06-01").positions[0]).toMatchObject({
      quantity: f("20"),
      cost: 100000,
      price: f("50"),
      priceSource: "trade",
      value: 100000,
      gain: 0,
    });
  });

  it("does not use a pre-split market price after the split", () => {
    const at = makeHoldingsValueAt(
      input({
        trades: [buy10, split("2024-06-01", "2")],
        prices: [
          { securityId: "s1", date: "2024-05-20", price: f("130") },
          { securityId: "s1", date: "2024-06-10", price: f("70") },
        ],
      }),
    );
    expect(at("2024-05-25").positions[0]).toMatchObject({
      price: f("130"),
      value: 130000,
    });
    // the 130 quote predates the split: fall back to the adjusted trade price
    expect(at("2024-06-05").positions[0]).toMatchObject({
      price: f("50"),
      priceSource: "trade",
    });
    expect(at("2024-06-10").positions[0]).toMatchObject({
      price: f("70"),
      value: 140000,
    });
  });

  it("handles a 1:10 reverse split", () => {
    const at = makeHoldingsValueAt(
      input({
        trades: [
          trade({
            date: "2024-01-01",
            quantity: f("100"),
            price: f("10"),
            amount: 100000,
          }),
          split("2024-06-01", "0.1"),
        ],
      }),
    );
    expect(at("2024-06-01").positions[0]).toMatchObject({
      quantity: f("10"),
      price: f("100"),
      cost: 100000,
      value: 100000,
    });
  });

  it("sells after a split remove cost in proportion", () => {
    const at = makeHoldingsValueAt(
      input({
        trades: [
          buy10,
          split("2024-06-01", "2"),
          trade({
            date: "2024-07-01",
            side: "sell",
            quantity: f("5"),
            price: f("60"),
            amount: 30000,
          }),
        ],
      }),
    );
    expect(at("2024-07-01").positions[0]).toMatchObject({
      quantity: f("15"),
      cost: 75000,
      price: f("60"),
    });
  });

  it("applies a split before the buys and sells of the same date", () => {
    const at = makeHoldingsValueAt(
      input({
        trades: [
          buy10,
          trade({
            date: "2024-06-01",
            side: "sell",
            quantity: f("15"),
            price: f("50"),
            amount: 75000,
          }),
          split("2024-06-01", "2"),
        ],
      }),
    );
    expect(at("2024-06-01").positions[0]!.quantity).toBe(f("5"));
  });

  it("ignores a split while nothing is held", () => {
    const at = makeHoldingsValueAt(
      input({ trades: [split("2023-12-01", "2"), buy10] }),
    );
    expect(at("2024-01-01").positions[0]!.quantity).toBe(f("10"));
  });

  it("works per security", () => {
    const at = makeHoldingsValueAt(
      input({
        securities: [etf, { ...etf, id: "s3", name: "Gamma" }],
        trades: [
          buy10,
          trade({ securityId: "s3", date: "2024-01-01", amount: 1 }),
          split("2024-06-01", "2"),
        ],
      }),
    );
    const quantities = Object.fromEntries(
      at("2024-06-01").positions.map((p) => [p.securityId, p.quantity]),
    );
    expect(quantities).toEqual({ s1: f("20"), s3: f("10") });
  });
});

describe("splits in the sequence checks", () => {
  const t = (date: string, side: "buy" | "sell" | "split", q: string) => ({
    date,
    side,
    quantity: f(q),
  });

  it("lets a sell use the split quantity and flags an oversell after it", () => {
    const base = [t("2024-01-01", "buy", "10"), t("2024-02-01", "split", "2")];
    expect(firstOversell([...base, t("2024-03-01", "sell", "20")])).toBeNull();
    expect(
      firstOversell([...base, t("2024-03-01", "sell", "20.00000001")]),
    ).toBe("2024-03-01");
  });

  it("a reverse split shrinks what can be sold", () => {
    const seq = [
      t("2024-01-01", "buy", "100"),
      t("2024-02-01", "split", "0.1"),
      t("2024-03-01", "sell", "11"),
    ];
    expect(firstOversell(seq)).toBe("2024-03-01");
    expect(heldQuantity(seq)).toBe(f("-1"));
  });

  it("flags a split with no shares", () => {
    expect(firstEmptySplit([t("2024-01-01", "split", "2")])).toBe("2024-01-01");
    expect(
      firstEmptySplit([
        t("2024-01-01", "buy", "1"),
        t("2024-01-02", "sell", "1"),
        t("2024-01-03", "split", "2"),
      ]),
    ).toBe("2024-01-03");
    expect(
      firstEmptySplit([
        t("2024-01-01", "buy", "1"),
        t("2024-01-02", "split", "2"),
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
