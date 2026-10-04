import { and, eq, lte } from "drizzle-orm";
import { minor, type Minor } from "$lib/money";
import {
  FIRST_BUY_IN_GAP_YEAR,
  gapsFor,
  settingFor,
  yearLimit,
  type GapYear,
} from "$lib/pillar-3a";
import type {
  Pillar3aDeduction,
  PortfolioCloseReason,
} from "$lib/pillar-3a-types";
import { accounts, getDB, portfolios, portfolioValues } from "$lib/server/db";
import { listAccounts } from "$lib/server/ledger/accounts";
import {
  ageBenefitDrawn,
  contributionFacts,
  listContributions,
} from "./contributions";
import { listYearSettings } from "./years";

export interface Pillar3aYearOverview {
  year: number;
  deduction: Pillar3aDeduction;
  earnedIncome: Minor | null;
  /** The setting is the previous year's (the year has none of its own). */
  settingInherited: boolean;
  limit: Minor;
  /** The limit is an estimate (year missing from the limits table, or a large deduction without income). */
  limitUnconfirmed: boolean;
  ordinary: Minor;
  buyIn: Minor;
  /** `max(0, limit - ordinary)`: what ordinary contributions still could fill. */
  gap: Minor;
  /** `max(0, ordinary - limit)`. */
  overLimit: Minor;
  /** Contribution id of the buy-in that closed this gap year. */
  closedBy: string | null;
  /** A buy-in may still close this year (2025 or later, before the running year, open gap). */
  buyInEligible: boolean;
}

export interface Pillar3aPortfolioOverview {
  portfolioId: string;
  accountId: string;
  accountName: string;
  /** The account is archived: listed, but left out of the totals. */
  archived: boolean;
  name: string;
  strategy: string | null;
  depositReference: string | null;
  closedOn: string | null;
  closeReason: PortfolioCloseReason | null;
  /** Newest value dated on or before today; for a closed portfolio its last one. */
  latestValue: Minor | null;
  latestValueDate: string | null;
  /** All contributions, ordinary and buy-in, of all years. */
  contributed: Minor;
  /** `latestValue - contributed`; null without a value. */
  gain: Minor | null;
}

export interface Pillar3aOverview {
  today: string;
  /** Newest year first: from 2025 (or the earliest year with contributions) to the running year. */
  years: Pillar3aYearOverview[];
  /** Years from 2025 to the year before today, as seen by the buy-in rules. */
  gaps: GapYear[];
  portfolios: Pillar3aPortfolioOverview[];
  totals: {
    /** Latest values of the portfolios that are open today, on accounts that are not archived. */
    value: Minor;
    /** Contributions to those portfolios. */
    contributed: Minor;
    gain: Minor;
    /** Current balance of all pillar 3a accounts, portfolios and cash. */
    accountsValue: Minor;
  };
  /** A portfolio was closed with the age benefit: no more buy-ins. */
  ageBenefitDrawn: boolean;
}

export function pillar3aOverview(
  userId: string,
  today: string,
): Pillar3aOverview {
  const db = getDB();
  const views = listContributions(userId);
  const settings = listYearSettings(userId);
  const facts = contributionFacts(views);
  const gaps = gapsFor({ ...facts, settings, today });
  const gapOf = new Map(gaps.map((g) => [g.year, g]));

  const thisYear = Number(today.slice(0, 4));
  const firstYear = Math.min(
    FIRST_BUY_IN_GAP_YEAR,
    thisYear,
    ...views.map((v) => v.year),
  );
  const years: Pillar3aYearOverview[] = [];
  for (let year = thisYear; year >= firstYear; year--) {
    const setting = settingFor(year, settings);
    const { limit, unconfirmed } = yearLimit(year, setting);
    const sum = (kind: "ordinary" | "buy_in") =>
      views
        .filter((v) => v.year === year && v.kind === kind)
        .reduce((s, v) => s + v.amount, 0);
    const ordinary = sum("ordinary");
    const gap = Math.max(0, limit - ordinary);
    const closedBy = gapOf.get(year)?.closedBy ?? null;
    years.push({
      year,
      deduction: setting.deduction,
      earnedIncome: setting.earnedIncome,
      settingInherited: setting.inherited,
      limit,
      limitUnconfirmed: unconfirmed,
      ordinary: minor(ordinary),
      buyIn: minor(sum("buy_in")),
      gap: minor(gap),
      overLimit: minor(Math.max(0, ordinary - limit)),
      closedBy,
      buyInEligible:
        year >= FIRST_BUY_IN_GAP_YEAR &&
        year < thisYear &&
        gap > 0 &&
        closedBy === null,
    });
  }

  const latest = new Map<string, { date: string; amount: Minor }>();
  for (const v of db
    .select({
      portfolioId: portfolioValues.portfolioId,
      date: portfolioValues.date,
      amount: portfolioValues.amount,
    })
    .from(portfolioValues)
    .where(
      and(eq(portfolioValues.userId, userId), lte(portfolioValues.date, today)),
    )
    .all()) {
    const current = latest.get(v.portfolioId);
    if (!current || v.date > current.date) {
      latest.set(v.portfolioId, { date: v.date, amount: v.amount });
    }
  }
  const contributedBy = new Map<string, number>();
  for (const v of views) {
    contributedBy.set(
      v.portfolioId,
      (contributedBy.get(v.portfolioId) ?? 0) + v.amount,
    );
  }

  const rows = db
    .select({
      id: portfolios.id,
      accountId: portfolios.accountId,
      accountName: accounts.name,
      archived: accounts.archived,
      name: portfolios.name,
      strategy: portfolios.strategy,
      depositReference: portfolios.depositReference,
      closedOn: portfolios.closedOn,
      closeReason: portfolios.closeReason,
      sortOrder: portfolios.sortOrder,
    })
    .from(portfolios)
    .innerJoin(accounts, eq(accounts.id, portfolios.accountId))
    .where(eq(portfolios.userId, userId))
    .all()
    .sort(
      (a, b) =>
        Number(a.closedOn !== null) - Number(b.closedOn !== null) ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
    );

  let value = 0;
  let contributedOpen = 0;
  const portfolioRows = rows.map((r): Pillar3aPortfolioOverview => {
    const v = latest.get(r.id) ?? null;
    const contributed = contributedBy.get(r.id) ?? 0;
    if (!r.archived && (r.closedOn === null || today < r.closedOn)) {
      value += v?.amount ?? 0;
      contributedOpen += contributed;
    }
    return {
      portfolioId: r.id,
      accountId: r.accountId,
      accountName: r.accountName,
      archived: r.archived,
      name: r.name,
      strategy: r.strategy,
      depositReference: r.depositReference,
      closedOn: r.closedOn,
      closeReason: r.closeReason,
      latestValue: v?.amount ?? null,
      latestValueDate: v?.date ?? null,
      contributed: minor(contributed),
      gain: v === null ? null : minor(v.amount - contributed),
    };
  });

  const accountsValue = listAccounts(userId, today)
    .filter((a) => a.type === "pillar_3a" && !a.archived)
    .reduce((s, a) => s + a.balance, 0);

  return {
    today,
    years,
    gaps,
    portfolios: portfolioRows,
    totals: {
      value: minor(value),
      contributed: minor(contributedOpen),
      gain: minor(value - contributedOpen),
      accountsValue: minor(accountsValue),
    },
    ageBenefitDrawn: ageBenefitDrawn(userId),
  };
}
