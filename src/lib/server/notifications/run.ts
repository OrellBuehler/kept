import { and, eq, max } from "drizzle-orm";
import { billViews } from "$lib/server/bills/status";
import { todayLocal } from "$lib/server/bills/dates";
import { budgetReport } from "$lib/server/categories/budgets";
import { accounts, getDB, imports } from "$lib/server/db";
import { deliver, type DispatchDeps } from "./dispatch";
import {
  digest,
  evaluateTriggers,
  type AccountFact,
  type BudgetFact,
  type Facts,
} from "./evaluate";
import {
  listEnabledChannelKinds,
  markSent,
  sentKeys,
  usersWithTriggers,
} from "./store";
import type { TriggerSettings } from "./types";
import { describeError } from "$lib/server/errors";

function accountFacts(userId: string): AccountFact[] {
  const lastImports = new Map(
    getDB()
      .select({ accountId: imports.accountId, last: max(imports.createdAt) })
      .from(imports)
      .where(eq(imports.userId, userId))
      .groupBy(imports.accountId)
      .all()
      .map((r) => [r.accountId, r.last]),
  );
  return getDB()
    .select({
      id: accounts.id,
      name: accounts.name,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.archived, false)))
    .all()
    .map((a) => {
      const last = lastImports.get(a.id);
      return {
        id: a.id,
        name: a.name,
        lastImportDate: todayLocal(last ? new Date(last) : a.createdAt),
      };
    });
}

async function gatherFacts(
  userId: string,
  settings: TriggerSettings,
  now: Date,
): Promise<Facts> {
  const today = todayLocal(now);
  const month = today.slice(0, 7);
  const needBills = settings.billDueEnabled || settings.billOverdueEnabled;
  const budgets: BudgetFact[] = settings.budgetEnabled
    ? (await budgetReport(userId, month)).currencies.flatMap((c) =>
        c.rows.map((r) => ({ ...r, currency: c.currency })),
      )
    : [];
  return {
    today,
    month,
    bills: needBills ? billViews(userId, { today }) : [],
    budgets,
    accounts: settings.staleImportEnabled ? accountFacts(userId) : [],
  };
}

/**
 * One pass for every user: evaluates their triggers, drops events already
 * notified and sends the rest as one message. An event is only marked as sent
 * once a channel accepted it, so a failing channel is retried on the next pass.
 */
export async function runNotifications(
  deps: DispatchDeps,
  now: Date = new Date(),
): Promise<void> {
  for (const { userId, settings } of usersWithTriggers()) {
    try {
      if (listEnabledChannelKinds(userId).length === 0) continue;
      const done = sentKeys(userId);
      const events = evaluateTriggers(
        settings,
        await gatherFacts(userId, settings, now),
      ).filter((e) => !done.has(e.key));
      const message = digest(events);
      if (!message) continue;
      if ((await deliver(userId, message, deps)) > 0) {
        markSent(
          userId,
          events.map((e) => e.key),
        );
      }
    } catch (err) {
      console.error("notification run failed", describeError(err));
    }
  }
}
