import { minor, type Minor } from "../../src/lib/money";
import {
  HISTORY_START,
  addMonths,
  between,
  lastDay,
  monthsUpTo,
  plain,
} from "./ledger";

export interface SecuritySpec {
  name: string;
  kind: "etf" | "fund" | "stock";
  currency: string;
  basePrice: Minor;
  trendBps: number;
}

export const SECURITIES: SecuritySpec[] = [
  {
    name: "Example World Equity ETF",
    kind: "etf",
    currency: "CHF",
    basePrice: minor(10120),
    trendBps: 110,
  },
  {
    name: "Example Swiss Bond Fund",
    kind: "fund",
    currency: "CHF",
    basePrice: minor(9640),
    trendBps: 12,
  },
  {
    name: "Example Holding AG",
    kind: "stock",
    currency: "CHF",
    basePrice: minor(18850),
    trendBps: -70,
  },
];

const spec = (name: string) => SECURITIES.find((s) => s.name === name)!;

function monthIndex(date: string): number {
  const [y, m] = date.split("-").map(Number);
  const [y0, m0] = HISTORY_START.split("-").map(Number);
  return (y! - y0!) * 12 + (m! - m0!);
}

export function priceOn(security: SecuritySpec, date: string): Minor {
  const wobble = between(`${security.name}:${date}`, -180, 180);
  const factor = 10_000 + security.trendBps * monthIndex(date) + wobble;
  return minor(Math.round((security.basePrice * factor) / 10_000));
}

export interface PriceSpec {
  security: string;
  date: string;
  price: Minor;
}

export interface TradeSpec {
  security: string;
  date: string;
  /** In ten-thousandths of a unit. */
  quantity: number;
  price: Minor;
  fees: Minor;
  amount: Minor;
}

const FEES = minor(150);

function buy(
  security: SecuritySpec,
  date: string,
  quantity: number,
  fees: Minor,
): TradeSpec {
  const price = priceOn(security, date);
  return {
    security: security.name,
    date,
    quantity,
    price,
    fees,
    amount: minor(Math.round((quantity * price) / 10_000) + fees),
  };
}

const savingsPlan = (security: SecuritySpec, date: string, target: number) =>
  buy(
    security,
    date,
    Math.floor((target * 10_000) / priceOn(security, date)),
    FEES,
  );

const STOCK_BUYS: [string, number][] = [
  ["2026-02-17", 50_000],
  ["2026-06-22", 40_000],
  ["2026-09-14", 30_000],
];

export function buildTrades(today: string): TradeSpec[] {
  const [etf, bond, stock] = SECURITIES;
  const trades = [
    ...monthsUpTo(today).flatMap((ym) => [
      savingsPlan(etf!, `${ym}-28`, 29_000),
      savingsPlan(bond!, `${ym}-28`, 10_000),
    ]),
    ...STOCK_BUYS.map(([date, quantity]) =>
      buy(stock!, date, quantity, minor(490)),
    ),
  ];
  return trades
    .filter((t) => t.date >= HISTORY_START && t.date <= today)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.security.localeCompare(b.security),
    );
}

export function buildPrices(today: string): PriceSpec[] {
  const dates = new Set(
    buildTrades(today).map((t) => `${t.security}|${t.date}`),
  );
  const prices = SECURITIES.flatMap((security) =>
    monthsUpTo(today).flatMap((ym) =>
      [`${ym}-14`, `${ym}-28`].map((date) => ({
        security: security.name,
        date,
        price: priceOn(security, date),
      })),
    ),
  );
  for (const key of dates) {
    const [name, date] = key.split("|") as [string, string];
    if (!prices.some((p) => p.security === name && p.date === date)) {
      prices.push({ security: name, date, price: priceOn(spec(name), date) });
    }
  }
  return prices
    .filter((p) => p.date <= today)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.security.localeCompare(b.security),
    );
}

export const tradeQuantity = (units: number) => {
  const whole = Math.floor(units / 10_000);
  return `${whole}.${String(units % 10_000).padStart(4, "0")}`;
};

export const PILLAR_3A_CONTRIBUTION = minor(725_800);
export const PILLAR_3A_OPENED = "2025-02-10";

export interface PortfolioValueSpec {
  date: string;
  value: Minor;
  gain: Minor;
  /** Hundredths of a percent. */
  gainBps: number;
}

/** What the provider would report: contributions grow month by month at a made-up return. */
export function buildPortfolioValues(today: string): PortfolioValueSpec[] {
  const first = "2025-02";
  const last = today.slice(0, 7);
  let value = 0;
  let contributed = 0;
  const monthEnds = new Map<string, PortfolioValueSpec>();
  for (let ym = first; ym <= last; ym = addMonths(ym, 1)) {
    if (ym === first || ym.endsWith("-02")) {
      value += PILLAR_3A_CONTRIBUTION;
      contributed += PILLAR_3A_CONTRIBUTION;
    }
    value = Math.round(
      (value * (10_000 + between(`3A-${ym}`, -90, 190))) / 10_000,
    );
    const gain = value - contributed;
    monthEnds.set(lastDay(ym), {
      date: lastDay(ym),
      value: minor(value),
      gain: minor(gain),
      gainBps: Math.round((gain * 10_000) / contributed),
    });
  }
  const dates = [...monthEnds.keys()].filter((d) => d <= today).sort();
  const wanted = new Set(
    dates.filter(
      (d) =>
        d === "2025-12-31" ||
        (d >= HISTORY_START &&
          ["03", "06", "09", "12"].includes(d.slice(5, 7))),
    ),
  );
  const latest = dates[dates.length - 1];
  if (latest !== undefined) wanted.add(latest);
  return [...wanted].sort().map((d) => monthEnds.get(d)!);
}

export const percentText = (bps: number) => plain(bps);
