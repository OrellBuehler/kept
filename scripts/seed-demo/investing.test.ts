import { describe, expect, it } from "vitest";
import { parseAmount } from "../../src/lib/money";
import { parseFixed } from "../../src/lib/quantity";
import { ACCOUNTS } from "./dataset";
import {
  SECURITIES,
  buildPortfolioValues,
  buildPrices,
  buildTrades,
  priceOn,
  tradeQuantity,
} from "./investing";
import { buildLedger, plain } from "./ledger";

describe("trades and prices", () => {
  it("are the same for the same day and only grow with later days", () => {
    expect(buildTrades("2026-11-24")).toEqual(buildTrades("2026-11-24"));
    const earlier = buildTrades("2026-06-30");
    const later = buildTrades("2026-11-24");
    expect(earlier.length).toBeGreaterThan(0);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
    const prices = buildPrices("2026-11-24");
    for (const p of buildPrices("2026-06-30")) expect(prices).toContainEqual(p);
  });

  it("prices every trade on its own day and never after today", () => {
    const prices = buildPrices("2026-11-24");
    for (const t of buildTrades("2026-11-24")) {
      expect(
        prices.find((p) => p.security === t.security && p.date === t.date)
          ?.price,
      ).toBe(t.price);
    }
    for (const p of prices) expect(p.date <= "2026-11-24").toBe(true);
    expect(new Set(prices.map((p) => `${p.security}|${p.date}`)).size).toBe(
      prices.length,
    );
  });

  it("charges quantity times price plus fees, as the server's forms expect them", () => {
    for (const t of buildTrades("2026-11-24")) {
      const quantity = parseFixed(tradeQuantity(t.quantity));
      expect(quantity).toBe(t.quantity * 10_000);
      expect(parseAmount(plain(t.price))).toBe(t.price);
      expect(t.amount).toBe(
        Math.round((t.quantity * t.price) / 10_000) + t.fees,
      );
      expect(t.quantity).toBeGreaterThan(0);
    }
    expect(tradeQuantity(28_500)).toBe("2.8500");
    expect(tradeQuantity(50_000)).toBe("5.0000");
  });

  it("keeps the broker's cash above zero when the investment plan is paid in", () => {
    const broker = ACCOUNTS.find((a) => a.key === "broker")!;
    const today = "2027-06-30";
    const deposits = buildLedger(today)
      .checking.filter((e) => e.id.startsWith("DEMO-INVEST-"))
      .map((e) => ({ date: e.date, amount: -e.amount }));
    const moves = [
      ...deposits,
      ...buildTrades(today).map((t) => ({ date: t.date, amount: -t.amount })),
    ].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    let cash: number = parseAmount(broker.openingBalance);
    for (const move of moves) {
      cash += move.amount;
      expect(cash).toBeGreaterThanOrEqual(0);
    }
  });

  it("moves prices a little from month to month", () => {
    for (const security of SECURITIES) {
      const a = priceOn(security, "2026-06-14");
      const b = priceOn(security, "2026-06-28");
      expect(Math.abs(b - a) / a).toBeLessThan(0.05);
    }
  });
});

describe("pillar 3a values", () => {
  it("lists the provider's figures by date up to today", () => {
    const values = buildPortfolioValues("2026-11-24");
    expect(values.map((v) => v.date)).toEqual([
      "2025-12-31",
      "2026-03-31",
      "2026-06-30",
      "2026-09-30",
      "2026-10-31",
    ]);
    for (const v of values) {
      expect(Math.sign(v.gainBps)).toBe(Math.sign(v.gain));
      expect(v.value).toBeGreaterThan(0);
    }
    expect(buildPortfolioValues("2026-11-24")).toEqual(values);
  });

  it("adds the newest month end without touching the older figures", () => {
    const earlier = buildPortfolioValues("2026-10-31");
    const later = buildPortfolioValues("2026-12-31");
    for (const v of earlier.slice(0, -1)) expect(later).toContainEqual(v);
    expect(later[later.length - 1]!.date).toBe("2026-12-31");
  });
});
