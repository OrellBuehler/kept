import { formatAmount } from "$lib/money";
import { daysBetween, type BillWithStatus } from "$lib/server/bills/status";
import type { BudgetRow } from "$lib/server/categories/budgets";
import type { NotificationEvent, TriggerSettings } from "./types";

export type BillFact = Pick<
  BillWithStatus,
  | "id"
  | "creditorName"
  | "invoiceNumber"
  | "kind"
  | "status"
  | "remaining"
  | "currency"
  | "dueDate"
  | "dueInDays"
  | "overdue"
>;

export type BudgetFact = Pick<
  BudgetRow,
  "budgetId" | "categoryName" | "budget" | "spent"
> & { currency: string };

export interface AccountFact {
  id: string;
  name: string;
  /** Local date (YYYY-MM-DD) of the last import, or of creation when none happened. */
  lastImportDate: string;
}

export interface Facts {
  /** Local date, YYYY-MM-DD. */
  today: string;
  /** YYYY-MM, the month the budgets are evaluated for. */
  month: string;
  bills: readonly BillFact[];
  budgets: readonly BudgetFact[];
  accounts: readonly AccountFact[];
}

const isOpen = (b: BillFact) =>
  b.kind === "invoice" &&
  (b.status === "open" || b.status === "partially_paid");

function billLabel(b: BillFact): string {
  const who = b.creditorName ?? b.invoiceNumber ?? "A bill";
  return b.remaining === null
    ? who
    : `${who} (${formatAmount(b.remaining, b.currency)})`;
}

const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** Pure: which notifications are warranted by the facts. Dedupe happens elsewhere, by `key`. */
export function evaluateTriggers(
  settings: TriggerSettings,
  facts: Facts,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];

  for (const b of facts.bills) {
    if (!isOpen(b) || b.dueDate === null || b.dueInDays === null) continue;
    if (settings.billOverdueEnabled && b.overdue) {
      events.push({
        key: `bill-overdue:${b.id}:${b.dueDate}`,
        title: "Bill overdue",
        body: `${billLabel(b)} was due on ${b.dueDate} (${plural(-b.dueInDays)} ago).`,
      });
    } else if (
      settings.billDueEnabled &&
      !b.overdue &&
      b.dueInDays >= 0 &&
      b.dueInDays <= settings.billDueDays
    ) {
      const when = b.dueInDays === 0 ? "today" : `in ${plural(b.dueInDays)}`;
      events.push({
        key: `bill-due:${b.id}:${b.dueDate}`,
        title: "Bill due soon",
        body: `${billLabel(b)} is due ${when} (${b.dueDate}).`,
      });
    }
  }

  if (settings.budgetEnabled) {
    for (const r of facts.budgets) {
      if (r.spent * 100 < r.budget * settings.budgetPercent) continue;
      events.push({
        key: `budget:${r.budgetId}:${facts.month}:${settings.budgetPercent}`,
        title: r.spent > r.budget ? "Budget exceeded" : "Budget nearly used",
        body: `${r.categoryName}: ${formatAmount(r.spent, r.currency)} of ${formatAmount(r.budget, r.currency)} spent in ${facts.month}.`,
      });
    }
  }

  if (settings.staleImportEnabled) {
    for (const a of facts.accounts) {
      const days = daysBetween(a.lastImportDate, facts.today);
      if (days < settings.staleImportDays) continue;
      events.push({
        key: `stale-import:${a.id}:${a.lastImportDate}`,
        title: "Account not imported",
        body: `${a.name} was last imported ${plural(days)} ago (${a.lastImportDate}).`,
      });
    }
  }

  return events;
}

/** One message per run, so a first run over old data does not flood the channel. */
export function digest(
  events: readonly NotificationEvent[],
): { title: string; body: string } | null {
  if (events.length === 0) return null;
  if (events.length === 1) {
    return { title: events[0].title, body: events[0].body };
  }
  return {
    title: `Kept: ${events.length} notifications`,
    body: events.map((e) => `${e.title}: ${e.body}`).join("\n"),
  };
}
