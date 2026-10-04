import type { Minor } from "$lib/money";
import { minor } from "$lib/money";
import type { Fixed8 } from "$lib/quantity";
import { fixed } from "$lib/quantity";
import { listAccounts } from "$lib/server/ledger/accounts";
import { loadHoldingsInputs } from "./load";
import { makeHoldingsValueAt, type Position } from "./valuation";

export interface CurrencyTotal {
  /** Account currency: holdings are already converted into it. */
  currency: string;
  value: Minor;
  cost: Minor;
  gain: Minor;
  estimated: boolean;
}

export interface AccountPosition extends Position {
  accountId: string;
  accountName: string;
  institutionName: string | null;
  accountCurrency: string;
}

export interface SecurityGroup {
  securityId: string;
  name: string;
  /** Currency `price` is quoted in. */
  currency: string;
  /** Units held across all accounts. */
  quantity: Fixed8;
  /** Price, date and source of the most recent price among the positions. */
  price: Fixed8;
  priceDate: string;
  priceSource: Position["priceSource"];
  /** Value, cost and gain per account currency (usually one entry). */
  totals: CurrencyTotal[];
  positions: AccountPosition[];
}

export interface InvestmentsOverview {
  totals: CurrencyTotal[];
  securities: SecurityGroup[];
}

function addTo(
  totals: Map<string, CurrencyTotal>,
  currency: string,
  p: Pick<Position, "value" | "cost" | "gain" | "estimated">,
) {
  const t = totals.get(currency) ?? {
    currency,
    value: minor(0),
    cost: minor(0),
    gain: minor(0),
    estimated: false,
  };
  t.value = minor(t.value + p.value);
  t.cost = minor(t.cost + p.cost);
  t.gain = minor(t.gain + p.gain);
  t.estimated ||= p.estimated;
  totals.set(currency, t);
}

const byCurrency = (a: CurrencyTotal, b: CurrencyTotal) =>
  a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;

/**
 * Current holdings of the user's non-archived accounts, as totals per account
 * currency and grouped by security. One batched load for all accounts.
 */
export function investmentsOverview(
  userId: string,
  today: string,
): InvestmentsOverview {
  const accounts = listAccounts(userId, today).filter((a) => !a.archived);
  const inputs = loadHoldingsInputs(
    userId,
    accounts.map((a) => a.id),
    today,
  );
  const totals = new Map<string, CurrencyTotal>();
  const groups = new Map<string, SecurityGroup>();
  const groupTotals = new Map<string, Map<string, CurrencyTotal>>();

  for (const account of accounts) {
    const input = inputs.get(account.id);
    if (!input) continue;
    for (const p of makeHoldingsValueAt(input)(today).positions) {
      addTo(totals, account.currency, p);
      const position: AccountPosition = {
        ...p,
        accountId: account.id,
        accountName: account.name,
        institutionName: account.institution?.name ?? null,
        accountCurrency: account.currency,
      };
      const group = groups.get(p.securityId);
      if (!group) {
        groups.set(p.securityId, {
          securityId: p.securityId,
          name: p.name,
          currency: p.currency,
          quantity: p.quantity,
          price: p.price,
          priceDate: p.priceDate,
          priceSource: p.priceSource,
          totals: [],
          positions: [position],
        });
        groupTotals.set(p.securityId, new Map());
      } else {
        group.quantity = fixed(group.quantity + p.quantity);
        if (p.priceDate > group.priceDate) {
          group.price = p.price;
          group.priceDate = p.priceDate;
          group.priceSource = p.priceSource;
        }
        group.positions.push(position);
      }
      addTo(groupTotals.get(p.securityId)!, account.currency, p);
    }
  }

  const securities = [...groups.values()].sort((a, b) =>
    a.name < b.name
      ? -1
      : a.name > b.name
        ? 1
        : a.securityId < b.securityId
          ? -1
          : 1,
  );
  for (const g of securities) {
    g.totals = [...groupTotals.get(g.securityId)!.values()].sort(byCurrency);
  }
  return { totals: [...totals.values()].sort(byCurrency), securities };
}
