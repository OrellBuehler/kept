import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { transaction } from "$lib/server/db";
import { isValidQrr } from "$lib/references";
import { parseForm } from "$lib/server/forms";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_QRR } from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount } from "$lib/testing/ledger";
import {
  errorCode,
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { closePortfolio } from "./portfolios";
import { parsePortfolioValuesForm, yearSettingSchema } from "./schemas";
import { deleteValue, listValues, setValues } from "./values";
import {
  listYearSettings,
  listYearSettingsInTx,
  setYearSetting,
} from "./years";
import { makePortfoliosValueAt } from "./valuation";

useTestDB();

function form(fields: [string, string][]) {
  const f = new FormData();
  for (const [k, v] of fields) f.append(k, v);
  return f;
}

describe("test helpers", () => {
  it("makeQrr produces valid references, matching the documented example", () => {
    expect(makeQrr(EXAMPLE_QRR.slice(0, 26))).toBe(EXAMPLE_QRR);
    for (const n of [0, 1, 99, 123456789])
      expect(isValidQrr(makeQrr(n))).toBe(true);
  });
});

describe("setValues", () => {
  it("upserts per (portfolio, date)", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const a = await seedPortfolio(u.id, acc.id, { name: "A" });
    const b = await seedPortfolio(u.id, acc.id, { name: "B" });
    const first = await setValues(u.id, acc.id, "2026-01-10", [
      { portfolioId: a.id, amount: minor(1000) },
      { portfolioId: b.id, amount: minor(2000) },
    ]);
    expect(first.map((v) => v.amount).sort()).toEqual([1000, 2000]);
    await setValues(
      u.id,
      acc.id,
      "2026-01-10",
      [{ portfolioId: a.id, amount: minor(1500) }],
      "fixed",
    );
    await setValues(u.id, acc.id, "2026-02-10", [
      { portfolioId: a.id, amount: minor(1600) },
    ]);
    const history = await listValues(u.id, a.id);
    expect(history.map((v) => [v.date, v.amount, v.note])).toEqual([
      ["2026-02-10", 1600, null],
      ["2026-01-10", 1500, "fixed"],
    ]);
    expect(await listValues(u.id, b.id)).toHaveLength(1);
  });

  it("deletes a single value", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const p = await seedPortfolio(u.id, acc.id);
    await setValues(u.id, acc.id, "2026-01-10", [
      { portfolioId: p.id, amount: minor(1) },
    ]);
    const [v] = await listValues(u.id, p.id);
    await deleteValue(u.id, v!.id);
    expect(await listValues(u.id, p.id)).toEqual([]);
    expect(await errorCode(() => deleteValue(u.id, v!.id))).toBe("not_found:");
  });

  it("rejects bad batches", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const other = await seedPillar3aAccount(u.id, { name: "Second" });
    const p = await seedPortfolio(u.id, acc.id);
    const q = await seedPortfolio(u.id, other.id, { name: "Q" });
    expect(
      await errorCode(() => setValues(u.id, acc.id, "2026-01-10", [])),
    ).toBe("invalid:");
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-01-10", [
          { portfolioId: p.id, amount: minor(1) },
          { portfolioId: p.id, amount: minor(2) },
        ]),
      ),
    ).toBe("invalid:");
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-01-10", [
          { portfolioId: p.id, amount: minor(-1) },
        ]),
      ),
    ).toBe("invalid:");
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-01-10", [
          { portfolioId: q.id, amount: minor(1) },
        ]),
      ),
    ).toBe("not_found:");
    expect(await listValues(u.id, p.id)).toEqual([]);
  });

  it("is atomic: a failing entry stores nothing", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const p = await seedPortfolio(u.id, acc.id);
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-01-10", [
          { portfolioId: p.id, amount: minor(5) },
          { portfolioId: "missing", amount: minor(5) },
        ]),
      ),
    ).toBe("not_found:");
    expect(await listValues(u.id, p.id)).toEqual([]);
  });

  it("refuses values on or after a portfolio's closing date", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const p = await seedPortfolio(u.id, acc.id);
    await closePortfolio(u.id, p.id, {
      closedOn: "2030-06-30",
      closeReason: "age",
    });
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2030-06-30", [
          { portfolioId: p.id, amount: minor(1) },
        ]),
      ),
    ).toBe("invalid:date");
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2030-06-29", [
          { portfolioId: p.id, amount: minor(1) },
        ]),
      ),
    ).toBeUndefined();
  });

  it("is invisible to other users", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const acc = await seedPillar3aAccount(owner.id);
    const p = await seedPortfolio(owner.id, acc.id);
    await setValues(owner.id, acc.id, "2026-01-10", [
      { portfolioId: p.id, amount: minor(10) },
    ]);
    const [v] = await listValues(owner.id, p.id);
    const otherAcc = await seedPillar3aAccount(other.id);
    expect(await errorCode(() => listValues(other.id, p.id))).toBe(
      "not_found:",
    );
    expect(await errorCode(() => deleteValue(other.id, v!.id))).toBe(
      "not_found:",
    );
    expect(
      await errorCode(() =>
        setValues(other.id, acc.id, "2026-01-10", [
          { portfolioId: p.id, amount: minor(1) },
        ]),
      ),
    ).toBe("not_found:");
    expect(
      await errorCode(() =>
        setValues(other.id, otherAcc.id, "2026-01-10", [
          { portfolioId: p.id, amount: minor(1) },
        ]),
      ),
    ).toBe("not_found:");
    expect((await listValues(owner.id, p.id))[0]!.amount).toBe(10);
  });

  it("works on any owned account id check", async () => {
    const u = await createTestUser();
    const acc = await seedAccount(u.id);
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-01-10", [
          { portfolioId: "x", amount: minor(1) },
        ]),
      ),
    ).toBe("not_found:");
  });
});

describe("parsePortfolioValuesForm", () => {
  it("collects filled amounts and skips blanks", () => {
    const r = parsePortfolioValuesForm(
      form([
        ["date", "2026-05-01"],
        ["note", " checked "],
        ["value:p1", "1'234.50"],
        ["value:p2", ""],
        ["value:p3", "0"],
      ]),
    );
    expect(r).toEqual({
      ok: true,
      data: {
        date: "2026-05-01",
        note: "checked",
        entries: [
          { portfolioId: "p1", amount: 123450 },
          { portfolioId: "p3", amount: 0 },
        ],
      },
    });
  });

  it("reports field errors", () => {
    const r = parsePortfolioValuesForm(
      form([
        ["date", "nope"],
        ["value:p1", "abc"],
        ["value:p2", "-5"],
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual([
        "date",
        "value:p1",
        "value:p2",
      ]);
    }
  });

  it("requires at least one amount", () => {
    const r = parsePortfolioValuesForm(
      form([
        ["date", "2026-05-01"],
        ["value:p1", " "],
      ]),
    );
    expect(r).toEqual({
      ok: false,
      errors: { form: ["Enter at least one value."] },
    });
  });
});

describe("makePortfoliosValueAt", () => {
  const input = [
    {
      closedOn: null,
      values: [
        { date: "2026-03-01", amount: 300 },
        { date: "2026-01-01", amount: 100 },
      ],
    },
    { closedOn: "2026-06-01", values: [{ date: "2026-02-01", amount: 50 }] },
  ];
  it("takes the latest value on or before the date and zero after closing", () => {
    const at = makePortfoliosValueAt(input);
    expect(at("2025-12-31")).toBe(0);
    expect(at("2026-01-01")).toBe(100);
    expect(at("2026-02-01")).toBe(150);
    expect(at("2026-03-01")).toBe(350);
    expect(at("2026-05-31")).toBe(350);
    expect(at("2026-06-01")).toBe(300);
    expect(at("2027-01-01")).toBe(300);
  });
  it("is zero without portfolios", () => {
    expect(makePortfoliosValueAt([])("2026-01-01")).toBe(0);
  });
});

describe("year settings", () => {
  it("upserts per year and scopes by user", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    await setYearSetting(u.id, {
      year: 2025,
      deduction: "large",
      earnedIncome: minor(5_000_000),
    });
    await setYearSetting(u.id, {
      year: 2025,
      deduction: "none",
      earnedIncome: null,
    });
    await setYearSetting(u.id, {
      year: 2026,
      deduction: "large",
      earnedIncome: minor(1),
    });
    expect(await listYearSettings(u.id)).toEqual([
      { year: 2025, deduction: "none", earnedIncome: null },
      { year: 2026, deduction: "large", earnedIncome: 1 },
    ]);
    expect(await listYearSettings(other.id)).toEqual([]);
  });

  it("parses the form and drops income unless large", () => {
    expect(parseForm(yearSettingSchema, new FormData()).ok).toBe(false);
    const f = form([
      ["year", "2026"],
      ["deduction", "small"],
      ["earnedIncome", "50000"],
    ]);
    expect(parseForm(yearSettingSchema, f)).toEqual({
      ok: true,
      data: { year: 2026, deduction: "small", earnedIncome: null },
    });
    const large = form([
      ["year", "2026"],
      ["deduction", "large"],
      ["earnedIncome", "50'000"],
    ]);
    expect(parseForm(yearSettingSchema, large)).toEqual({
      ok: true,
      data: { year: 2026, deduction: "large", earnedIncome: 5_000_000 },
    });
  });
});

describe("setValues is all or nothing", () => {
  it("writes none of the entries when one is refused", async () => {
    const u = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const open = await seedPortfolio(u.id, acc.id, { name: "Open" });
    const closed = await seedPortfolio(u.id, acc.id, { name: "Closed" });
    await closePortfolio(u.id, closed.id, {
      closedOn: "2026-01-01",
      closeReason: "age",
    });
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-02-10", [
          { portfolioId: open.id, amount: minor(1000) },
          { portfolioId: closed.id, amount: minor(2000) },
        ]),
      ),
    ).toBe("invalid:date");
    expect(await listValues(u.id, open.id)).toEqual([]);
  });

  it("refuses a portfolio of another account or user before writing anything", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    const mine = await seedPortfolio(u.id, acc.id);
    const theirAcc = await seedPillar3aAccount(other.id);
    const theirs = await seedPortfolio(other.id, theirAcc.id);
    expect(
      await errorCode(() =>
        setValues(u.id, acc.id, "2026-02-10", [
          { portfolioId: mine.id, amount: minor(1000) },
          { portfolioId: theirs.id, amount: minor(2000) },
        ]),
      ),
    ).toBe("not_found:");
    expect(await listValues(u.id, mine.id)).toEqual([]);
    expect(await listValues(other.id, theirs.id)).toEqual([]);
  });

  it("looks the account up first and requires at least one value", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = await seedPillar3aAccount(u.id);
    expect(
      await errorCode(() => setValues(u.id, acc.id, "2026-02-10", [])),
    ).toBe("invalid:");
    expect(
      await errorCode(() => setValues(other.id, acc.id, "2026-02-10", [])),
    ).toBe("not_found:");
  });
});

describe("listYearSettingsInTx", () => {
  it("matches listYearSettings and only sees the user's years", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    await setYearSetting(u.id, {
      year: 2026,
      deduction: "large",
      earnedIncome: minor(9_000_000),
    });
    await setYearSetting(other.id, {
      year: 2025,
      deduction: "small",
      earnedIncome: null,
    });
    const viaTx = await transaction(async (tx) =>
      listYearSettingsInTx(tx, u.id),
    );
    expect(viaTx).toEqual(await listYearSettings(u.id));
    expect(viaTx.map((y) => y.year)).toEqual([2026]);
  });
});
