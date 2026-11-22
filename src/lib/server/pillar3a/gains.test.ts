import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { formatReturn, returnBps } from "$lib/pillar-3a";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { seedPillar3aAccount, seedPortfolio } from "$lib/testing/pillar3a";
import { pillar3aOverview } from "./overview";
import { listPortfolios } from "./portfolios";
import { parsePortfolioValuesForm } from "./schemas";
import { listValues, portfolioPerformance, setValues } from "./values";

useTestDB();

function form(fields: [string, string][]) {
  const f = new FormData();
  for (const [k, v] of fields) f.append(k, v);
  return f;
}

describe("returnBps", () => {
  it("prefers the reported return", () => {
    expect(returnBps({ amount: 11000, gain: 1000, gainBps: 1234 })).toBe(1234);
  });

  it("derives it from the gain over the capital it grew from", () => {
    expect(returnBps({ amount: 11000, gain: 1000, gainBps: null })).toBe(1000);
    expect(returnBps({ amount: 9000, gain: -1000, gainBps: null })).toBe(-1000);
    expect(returnBps({ amount: 10333, gain: 333, gainBps: null })).toBe(333);
  });

  it("is null without a gain or without capital", () => {
    expect(returnBps({ amount: 11000, gain: null, gainBps: null })).toBeNull();
    expect(returnBps({ amount: 1000, gain: 1000, gainBps: null })).toBeNull();
    expect(returnBps({ amount: 1000, gain: 2000, gainBps: null })).toBeNull();
  });
});

describe("formatReturn", () => {
  it("formats hundredths of a percent with a sign", () => {
    expect(formatReturn(425)).toBe("+4.25%");
    expect(formatReturn(-1250)).toBe("-12.50%");
    expect(formatReturn(0)).toBe("0.00%");
  });
});

describe("parsePortfolioValuesForm with gains", () => {
  it("attaches gain and return to the value of the same portfolio", () => {
    const parsed = parsePortfolioValuesForm(
      form([
        ["date", "2026-03-01"],
        ["value:a", "11'000.00"],
        ["gain:a", "1'000.50"],
        ["gainPercent:a", "10,05 %"],
        ["value:b", "900"],
        ["gain:b", "\u2212100"],
        ["value:c", "500"],
        ["gain:c", " "],
        ["gainPercent:c", ""],
      ]),
    );
    expect(parsed.ok && parsed.data.entries).toEqual([
      { portfolioId: "a", amount: 1100000, gain: 100050, gainBps: 1005 },
      { portfolioId: "b", amount: 90000, gain: -10000 },
      { portfolioId: "c", amount: 50000, gain: null, gainBps: null },
    ]);
  });

  it("refuses a gain the return cannot be worked out from", () => {
    const parsed = parsePortfolioValuesForm(
      form([
        ["date", "2026-03-01"],
        ["value:a", "1000"],
        ["gain:a", "1500"],
        ["value:b", "10000.00"],
        ["gain:b", "9999.99"],
        ["value:c", "1000"],
        ["gain:c", "1500"],
        ["gainPercent:c", "300"],
      ]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors).sort()).toEqual(["gain:a", "gain:b"]);
  });

  it("accepts a negative return and a gain entered before its value", () => {
    const parsed = parsePortfolioValuesForm(
      form([
        ["date", "2026-03-01"],
        ["gainPercent:a", "-3.5"],
        ["value:a", "100"],
      ]),
    );
    expect(parsed.ok && parsed.data.entries).toEqual([
      { portfolioId: "a", amount: 10000, gainBps: -350 },
    ]);
  });

  it("reports a gain without a value, and invalid gains", () => {
    const parsed = parsePortfolioValuesForm(
      form([
        ["date", "2026-03-01"],
        ["value:a", "100"],
        ["gain:a", "abc"],
        ["gainPercent:a", "1.234"],
        ["gain:b", "50"],
        ["value:c", "nope"],
        ["gain:c", "5"],
        ["value:d", "100"],
        ["gainPercent:d", "1000000"],
      ]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors).sort()).toEqual([
      "gain:a",
      "gain:b",
      "gainPercent:a",
      "gainPercent:d",
      "value:c",
    ]);
    expect(parsed.errors["gain:b"]).toEqual([
      "Enter the value of this portfolio too.",
    ]);
  });
});

describe("reported gains", () => {
  it("are stored with the value, replaced on re-entry and shown as the latest", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const a = await seedPortfolio(u.id, acc.id, { name: "A" });
    const b = await seedPortfolio(u.id, acc.id, { name: "B" });
    await setValues(u.id, acc.id, "2026-01-10", [
      {
        portfolioId: a.id,
        amount: minor(110000),
        gain: minor(10000),
        gainBps: 950,
      },
      { portfolioId: b.id, amount: minor(50000) },
    ]);
    await setValues(u.id, acc.id, "2026-02-10", [
      { portfolioId: a.id, amount: minor(120000), gain: minor(20000) },
    ]);
    expect(
      (await listValues(u.id, a.id)).map((v) => [v.date, v.gain, v.gainBps]),
    ).toEqual([
      ["2026-02-10", 20000, null],
      ["2026-01-10", 10000, 950],
    ]);

    const views = await listPortfolios(u.id, acc.id);
    const viewA = views.find((p) => p.id === a.id)!;
    const viewB = views.find((p) => p.id === b.id)!;
    expect([viewA.latestGain, viewA.latestGainBps]).toEqual([20000, 2000]);
    expect([viewB.latestGain, viewB.latestGainBps]).toEqual([null, null]);

    const overview = await pillar3aOverview(u.id, "2026-03-01");
    const rowA = overview.portfolios.find((p) => p.portfolioId === a.id)!;
    expect([rowA.reportedGain, rowA.returnBps]).toEqual([20000, 2000]);
    // The computed gain still is the value minus the contributions.
    expect(rowA.gain).toBe(120000);

    // A client that knows no gains (an older app) saves the date again: kept.
    await setValues(u.id, acc.id, "2026-02-10", [
      { portfolioId: a.id, amount: minor(125000) },
    ]);
    expect((await listValues(u.id, a.id))[0]).toMatchObject({
      amount: 125000,
      gain: 20000,
      gainBps: null,
    });
    // A blank gain clears it.
    await setValues(u.id, acc.id, "2026-02-10", [
      { portfolioId: a.id, amount: minor(125000), gain: null, gainBps: null },
    ]);
    expect((await listValues(u.id, a.id))[0]).toMatchObject({
      gain: null,
      gainBps: null,
    });
  });
});

describe("portfolioPerformance", () => {
  it("lists the values with a gain per portfolio, oldest first, up to today", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const a = await seedPortfolio(u.id, acc.id, { name: "A" });
    const b = await seedPortfolio(u.id, acc.id, { name: "B" });
    const c = await seedPortfolio(u.id, acc.id, { name: "C" });
    await setValues(u.id, acc.id, "2026-02-10", [
      { portfolioId: a.id, amount: minor(120000), gain: minor(20000) },
      { portfolioId: b.id, amount: minor(50000), gainBps: -125 },
      { portfolioId: c.id, amount: minor(70000) },
    ]);
    await setValues(u.id, acc.id, "2026-01-10", [
      { portfolioId: a.id, amount: minor(110000), gain: minor(10000) },
    ]);
    await setValues(u.id, acc.id, "2026-04-10", [
      { portfolioId: a.id, amount: minor(130000), gain: minor(30000) },
    ]);

    const performance = await portfolioPerformance(u.id, "2026-03-01");
    const of = (id: string) =>
      performance.find((p) => p.portfolioId === id)?.points;
    expect(of(a.id)).toEqual([
      { date: "2026-01-10", amount: 110000, gain: 10000, gainBps: 1000 },
      { date: "2026-02-10", amount: 120000, gain: 20000, gainBps: 2000 },
    ]);
    expect(of(b.id)).toEqual([
      { date: "2026-02-10", amount: 50000, gain: null, gainBps: -125 },
    ]);
    expect(of(c.id)).toBeUndefined();
    expect(await portfolioPerformance(other.id, "2026-03-01")).toEqual([]);
  });
});
