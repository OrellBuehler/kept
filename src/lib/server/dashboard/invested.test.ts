import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { investedTotals } from "./invested";

const m = minor;
const holdings = (value: number, cost: number, estimated = false) => ({
  value: m(value),
  cost: m(cost),
  estimated,
});

describe("investedTotals", () => {
  it("is empty without holdings", () => {
    expect(investedTotals([])).toEqual([]);
    expect(
      investedTotals([
        { currency: "CHF", shareBps: 10000, holdings: null },
        { currency: "CHF", shareBps: 10000, holdings: holdings(0, 0) },
      ]),
    ).toEqual([]);
  });

  it("sums value, cost and gain per currency", () => {
    expect(
      investedTotals([
        { currency: "CHF", shareBps: 10000, holdings: holdings(1200, 1000) },
        { currency: "CHF", shareBps: 10000, holdings: holdings(300, 400) },
        { currency: "EUR", shareBps: 10000, holdings: holdings(50, 50) },
        { currency: "CHF", shareBps: 10000, holdings: null },
      ]),
    ).toEqual([
      {
        currency: "CHF",
        value: 1500,
        cost: 1400,
        gain: 100,
        shareValue: 1500,
        shareGain: 100,
        accountCount: 2,
        estimated: false,
      },
      {
        currency: "EUR",
        value: 50,
        cost: 50,
        gain: 0,
        shareValue: 50,
        shareGain: 0,
        accountCount: 1,
        estimated: false,
      },
    ]);
  });

  it("applies the ownership share and carries the estimated flag", () => {
    const [t] = investedTotals([
      { currency: "CHF", shareBps: 5000, holdings: holdings(1200, 1000, true) },
      { currency: "CHF", shareBps: 10000, holdings: holdings(100, 100) },
    ]);
    expect(t).toMatchObject({
      value: 1300,
      cost: 1100,
      gain: 200,
      shareValue: 700,
      shareGain: 100,
      estimated: true,
    });
  });
});
