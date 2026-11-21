import { z } from "zod";
import { evaluateTriggers } from "$lib/server/notifications/evaluate";
import { gatherFacts } from "$lib/server/notifications/run";
import type { TriggerSettings } from "$lib/server/notifications/types";

const days = (max: number) =>
  z
    .string()
    .regex(/^\d{1,3}$/, "Use a whole number.")
    .transform(Number)
    .pipe(z.number().int().min(0).max(max));

/**
 * What the device wants to be reminded of. The settings live on the device
 * (they are about its notifications, not the server's channels); a parameter
 * that is left out switches that reminder off.
 */
export const reminderQuerySchema = z.object({
  /** Remind this many days before a bill is due. */
  billDueDays: days(60).optional(),
  billOverdue: z.enum(["true", "false"]).optional(),
  /** Remind when a budget is used to this percentage. */
  budgetPercent: days(500).pipe(z.number().min(1)).optional(),
  /** Remind when an account saw no import for this many days. */
  staleImportDays: days(365).pipe(z.number().min(1)).optional(),
});

export type ReminderQuery = z.output<typeof reminderQuerySchema>;

export interface ReminderBill {
  id: string;
  creditorName: string | null;
  invoiceNumber: string | null;
  /** Minor units still to pay, or null when the bill has no amount. */
  remaining: number | null;
  currency: string;
  dueDate: string;
}

export interface Reminders {
  /** Local date of the server, YYYY-MM-DD. */
  today: string;
  /** What is worth a notification right now. `key` is stable: show each key once. */
  events: { key: string; kind: string; title: string; body: string }[];
  /** Open bills with a due date, for notifications the device schedules ahead. */
  bills: ReminderBill[];
}

export async function reminders(
  userId: string,
  query: ReminderQuery,
  now: Date = new Date(),
): Promise<Reminders> {
  const settings: TriggerSettings = {
    billDueEnabled: query.billDueDays !== undefined,
    billDueDays: query.billDueDays ?? 0,
    billOverdueEnabled: query.billOverdue === "true",
    budgetEnabled: query.budgetPercent !== undefined,
    budgetPercent: query.budgetPercent ?? 100,
    staleImportEnabled: query.staleImportDays !== undefined,
    staleImportDays: query.staleImportDays ?? 14,
  };
  // Bills are always read: the device schedules its own "due" notifications from them.
  const facts = await gatherFacts(
    userId,
    { ...settings, billDueEnabled: true },
    now,
  );
  return {
    today: facts.today,
    events: evaluateTriggers(settings, facts).map((e) => ({
      ...e,
      kind: e.key.slice(0, e.key.indexOf(":")),
    })),
    bills: facts.bills
      .filter(
        (b) =>
          b.kind === "invoice" &&
          (b.status === "open" || b.status === "partially_paid") &&
          b.dueDate !== null,
      )
      .map((b) => ({
        id: b.id,
        creditorName: b.creditorName,
        invoiceNumber: b.invoiceNumber,
        remaining: b.remaining,
        currency: b.currency,
        dueDate: b.dueDate as string,
      }))
      .sort((a, b) =>
        a.dueDate === b.dueDate
          ? a.id.localeCompare(b.id)
          : a.dueDate.localeCompare(b.dueDate),
      ),
  };
}
