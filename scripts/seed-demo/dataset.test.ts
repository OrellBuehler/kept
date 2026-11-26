import { describe, expect, it } from "vitest";
import { ACCOUNTS, BUDGETS, CATEGORIES, INSTITUTIONS, RULES } from "./dataset";
import { buildLedger } from "./ledger";

const contains = (text: string | null, needle: string) =>
  text !== null && text.toLowerCase().includes(needle.toLowerCase());

describe("dataset", () => {
  it("lists parents before their subcategories and uses each name once", () => {
    const seen = new Set<string>();
    for (const category of CATEGORIES) {
      if (category.parent) expect(seen.has(category.parent)).toBe(true);
      expect(seen.has(category.name)).toBe(false);
      seen.add(category.name);
    }
  });

  it("refers to categories and institutions that exist", () => {
    const names = new Set(CATEGORIES.map((c) => c.name));
    for (const rule of RULES) expect(names.has(rule.category)).toBe(true);
    for (const budget of BUDGETS) {
      expect(names.has(budget.category)).toBe(true);
      expect(CATEGORIES.find((c) => c.name === budget.category)!.kind).toBe(
        "expense",
      );
    }
    const institutions = new Set(INSTITUTIONS.map((i) => i.name));
    for (const account of ACCOUNTS) {
      expect(institutions.has(account.institution)).toBe(true);
    }
    expect(new Set(ACCOUNTS.map((a) => a.name)).size).toBe(ACCOUNTS.length);
    expect(institutions.size).toBeLessThanOrEqual(3);
  });

  it("gives every rule a condition and links to the example domain only", () => {
    for (const rule of RULES) {
      expect(
        rule.counterpartyContains ?? rule.descriptionContains,
      ).toBeTruthy();
    }
    for (const url of [
      ...INSTITUTIONS.map((i) => i.websiteUrl),
      ...ACCOUNTS.map((a) => a.websiteUrl),
    ]) {
      expect(new URL(url).hostname).toBe("example.org");
    }
  });

  it("files every payment under a category, except transfers and a few one-offs", () => {
    const ledger = buildLedger("2027-12-31");
    const categorised = (e: {
      counterparty: string;
      description: string;
      amount: number;
    }) =>
      RULES.some(
        (r) =>
          (r.counterpartyContains === undefined ||
            contains(e.counterparty, r.counterpartyContains)) &&
          (r.descriptionContains === undefined ||
            contains(e.description, r.descriptionContains)) &&
          (r.amountSign !== "income" || e.amount > 0),
      );
    const left = new Set(
      [...ledger.checking, ...ledger.savings, ...ledger.wallet]
        .filter((e) => !categorised(e))
        .map((e) => e.counterparty),
    );
    expect([...left].sort()).toEqual([
      "Everyday account",
      "Example Broker",
      "Example Broker Pillar 3a",
      "Example Hardware Store",
      "Example Pay",
      "Rainy-day savings",
    ]);
  });
});
