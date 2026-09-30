import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Minor } from "$lib/money";
import { toDecimalString } from "$lib/money";
import {
  getDB,
  paperlessConnections,
  paperlessDocuments,
} from "$lib/server/db";
import type { PaperlessFieldMapping } from "$lib/server/db";
import { todayLocal } from "$lib/server/bills/dates";
import { billView, type BillWithStatus } from "$lib/server/bills/status";
import { LedgerError } from "$lib/server/ledger/errors";
import { PaperlessError, errorCode } from "./client";
import {
  clientForRow,
  recordConnectionState,
  rememberServerInfo,
} from "./connection";

/**
 * Paperless monetary custom fields only accept `CUR123.45`: an uppercase ISO
 * code followed by one or two decimals. Built with integer arithmetic; other
 * exponents (JPY, KWD, ...) do not fit and are not pushed.
 */
export function monetaryString(amount: Minor, currency: string): string | null {
  return monetaryProblem(amount, currency) === null
    ? `${currency}${toDecimalString(amount, 2)}`
    : null;
}

/** Why an amount cannot be written to a Paperless monetary field, or null when it can. */
export function monetaryProblem(
  amount: Minor,
  currency: string,
): "unsupported_currency" | "non_positive" | null {
  if (amount <= 0) return "non_positive";
  if (!/^[A-Z]{3}$/.test(currency)) return "unsupported_currency";
  let exponent: number;
  try {
    exponent = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits!;
  } catch (err) {
    if (err instanceof RangeError) return "unsupported_currency";
    throw err;
  }
  return exponent === 2 ? null : "unsupported_currency";
}

export interface PushPlan {
  /** Paperless custom field id -> value to write. */
  values: Record<string, string>;
  notes: string[];
}

export function buildPushPlan(
  bill: BillWithStatus,
  mapping: PaperlessFieldMapping,
): PushPlan {
  const values: Record<string, string> = {};
  const notes: string[] = [];
  if (mapping.amount != null && bill.amount !== null) {
    const problem = monetaryProblem(bill.amount, bill.currency);
    if (problem === "non_positive") {
      notes.push("The bill amount is not positive and was not pushed.");
    } else if (problem !== null) {
      notes.push(
        `Amounts in ${bill.currency} cannot be written to a Paperless monetary field.`,
      );
    } else
      values[String(mapping.amount)] = monetaryString(
        bill.amount,
        bill.currency,
      )!;
  }
  if (mapping.dueDate != null && bill.dueDate !== null) {
    values[String(mapping.dueDate)] = bill.dueDate;
  }
  if (mapping.reference != null && bill.reference !== null) {
    values[String(mapping.reference)] = bill.reference.slice(0, 128);
  }
  if (mapping.status != null) {
    const configured = mapping.statusValues ?? {};
    const value =
      configured[bill.status] ??
      (Object.keys(configured).length === 0 ? bill.status : undefined);
    if (value === undefined) {
      notes.push(
        `No Paperless value is mapped for the status "${bill.status}".`,
      );
    } else values[String(mapping.status)] = value;
  }
  return { values, notes };
}

export function hashPlan(plan: PushPlan): string {
  const entries = Object.entries(plan.values).sort(([a], [b]) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export type PushResult =
  | { status: "pushed" | "unchanged"; notes: string[] }
  | {
      status: "skipped";
      reason:
        | "not_linked"
        | "disabled"
        | "no_mapping"
        | "nothing_to_push"
        | "read_only"
        | "gone";
      notes: string[];
    };

const metaSchema = z.object({
  id: z.number().int(),
  modified: z.string().nullish(),
  user_can_change: z.boolean().nullish(),
});

const skipped = (
  reason: Extract<PushResult, { status: "skipped" }>["reason"],
  notes: string[] = [],
): PushResult => ({ status: "skipped", reason, notes });

/** Writes the bill's mapped fields to its linked Paperless document (merge, other fields untouched). */
export async function pushBill(
  userId: string,
  billId: string,
): Promise<PushResult> {
  const db = getDB();
  const link = db
    .select()
    .from(paperlessDocuments)
    .where(
      and(
        eq(paperlessDocuments.userId, userId),
        eq(paperlessDocuments.billId, billId),
      ),
    )
    .get();
  if (!link) return skipped("not_linked");
  const row = db
    .select()
    .from(paperlessConnections)
    .where(
      and(
        eq(paperlessConnections.userId, userId),
        eq(paperlessConnections.id, link.connectionId),
      ),
    )
    .get();
  if (!row || !row.enabled) return skipped("disabled");
  const mapping = row.fieldMapping;
  if (
    !mapping ||
    (mapping.amount == null &&
      mapping.dueDate == null &&
      mapping.reference == null &&
      mapping.status == null)
  ) {
    return skipped("no_mapping");
  }

  const bill = billView(userId, billId, { today: todayLocal() });
  const plan = buildPushPlan(bill, mapping);
  if (Object.keys(plan.values).length === 0) {
    return skipped("nothing_to_push", plan.notes);
  }
  const hash = hashPlan(plan);
  if (hash === link.lastPushedHash) {
    return { status: "unchanged", notes: plan.notes };
  }
  // Remembered read-only result: no refetch until the values or the document change.
  if (link.lastPushedHash === `ro:${hash}`) {
    return skipped("read_only", plan.notes);
  }

  const client = clientForRow(row);
  const query = { fields: "id,modified,user_can_change" };
  let meta: z.output<typeof metaSchema>;
  try {
    meta = await client.json(`documents/${link.paperlessId}`, metaSchema, {
      query,
    });
    if (meta.user_can_change === false) {
      db.update(paperlessDocuments)
        .set({ lastPushedHash: `ro:${hash}` })
        .where(
          and(
            eq(paperlessDocuments.userId, userId),
            eq(paperlessDocuments.id, link.id),
          ),
        )
        .run();
      return skipped("read_only", plan.notes);
    }
    await client.json("documents/bulk_edit", z.unknown(), {
      method: "POST",
      json: {
        documents: [link.paperlessId],
        method: "modify_custom_fields",
        parameters: {
          add_custom_fields: plan.values,
          remove_custom_fields: [],
        },
      },
    });
  } catch (err) {
    if (err instanceof PaperlessError && err.code === "not_found") {
      return skipped("gone", plan.notes);
    }
    throw err;
  }
  rememberServerInfo(row, client);

  db.update(paperlessDocuments)
    .set({ lastPushedHash: hash })
    .where(
      and(
        eq(paperlessDocuments.userId, userId),
        eq(paperlessDocuments.id, link.id),
      ),
    )
    .run();

  // The write bumped `modified`; remember it so the next sync does not re-import our own change.
  try {
    const after = await client.json(
      `documents/${link.paperlessId}`,
      metaSchema,
      { query },
    );
    const ms = after.modified ? Date.parse(after.modified) : NaN;
    if (Number.isFinite(ms)) {
      db.update(paperlessDocuments)
        .set({ modified: ms })
        .where(
          and(
            eq(paperlessDocuments.userId, userId),
            eq(paperlessDocuments.id, link.id),
          ),
        )
        .run();
    }
  } catch (err) {
    if (!(err instanceof PaperlessError)) throw err;
    console.warn("paperless: could not read back modified", err.code);
  }
  return { status: "pushed", notes: plan.notes };
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Listener-safe push: serialised per bill, failures are recorded on the
 * connection (code only) and logged, never thrown.
 */
export function pushBillSafely(
  userId: string,
  billId: string,
): Promise<PushResult | null> {
  const key = `${userId}:${billId}`;
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = async (): Promise<PushResult | null> => {
    try {
      return await pushBill(userId, billId);
    } catch (err) {
      if (err instanceof LedgerError && err.code === "not_found") return null;
      const code = errorCode(err);
      console.error("paperless push failed", code);
      const row = getDB()
        .select()
        .from(paperlessConnections)
        .where(eq(paperlessConnections.userId, userId))
        .get();
      if (row) recordConnectionState(row, { lastError: `push_${code}` });
      return null;
    }
  };
  const tail = previous.then(run, run);
  inFlight.set(key, tail);
  void tail.finally(() => {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  });
  return tail;
}

/** Re-checks every linked bill; only those whose values changed touch the network. */
export async function pushAllLinked(userId: string): Promise<number> {
  const links = getDB()
    .select({ billId: paperlessDocuments.billId })
    .from(paperlessDocuments)
    .where(
      and(
        eq(paperlessDocuments.userId, userId),
        isNotNull(paperlessDocuments.billId),
      ),
    )
    .all();
  let pushed = 0;
  for (const l of links) {
    const result = await pushBillSafely(userId, l.billId!);
    if (result?.status === "pushed") pushed++;
  }
  return pushed;
}
