import { and, eq, or } from "drizzle-orm";
import { normalizeIban } from "$lib/iban";
import { minor } from "$lib/money";
import { transactions, transfers } from "$lib/server/db";
import {
  linkAfterWrite,
  loadPlanAccounts,
  type Conn,
  type LinkResult,
} from "./link";
import { accountsByIban, canMirrorOnto, counterAmount } from "./plan";

/**
 * Keeps the transfer of a manual transaction in step after it was edited
 * (`previousIban` is its counterparty IBAN before the edit): a mirror follows
 * the source's amount, dates and text; one that no longer fits is removed;
 * a changed counterparty forgets an earlier unlink. Then the row is linked
 * again where it can be. Pairs made with a real row are left as they are.
 */
export function resyncSource(
  userId: string,
  transactionId: string,
  previousIban: string | null,
  conn: Conn,
): LinkResult {
  const source = conn
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.userId, userId), eq(transactions.id, transactionId)),
    )
    .get();
  if (!source || source.source === "mirror") {
    return { paired: 0, mirrored: 0, needsAmount: 0 };
  }
  const ibanChanged =
    (previousIban === null ? null : normalizeIban(previousIban)) !==
    (source.counterpartyIban === null
      ? null
      : normalizeIban(source.counterpartyIban));

  const rows = conn
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        or(
          eq(transfers.outTransactionId, transactionId),
          eq(transfers.inTransactionId, transactionId),
        ),
      ),
    )
    .all();
  const plan = loadPlanAccounts(userId, conn);
  const home = plan.find((a) => a.id === source.accountId);
  const target = source.counterpartyIban
    ? accountsByIban(plan).get(normalizeIban(source.counterpartyIban))
    : undefined;

  for (const t of rows) {
    const mirrorId =
      t.outTransactionId === transactionId
        ? t.inTransactionId
        : t.outTransactionId;
    if (t.status === "dismissed") {
      if (ibanChanged)
        conn.delete(transfers).where(eq(transfers.id, t.id)).run();
      continue;
    }
    if (t.status === "needs_amount") {
      conn.delete(transfers).where(eq(transfers.id, t.id)).run();
      continue;
    }
    if (t.method !== "mirrored" || mirrorId === null) continue;
    const mirror = conn
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.id, mirrorId), eq(transactions.source, "mirror")),
      )
      .get();
    if (!mirror) continue;
    const amount = target ? counterAmount(source, target) : null;
    if (
      !home ||
      !target ||
      amount === null ||
      target.id !== mirror.accountId ||
      Math.sign(amount) !== Math.sign(mirror.amount) ||
      !canMirrorOnto(target, source.bookingDate)
    ) {
      conn.delete(transactions).where(eq(transactions.id, mirror.id)).run();
      continue;
    }
    conn
      .update(transactions)
      .set({
        bookingDate: source.bookingDate,
        valueDate: source.valueDate,
        amount: minor(amount),
        counterpartyName: home.name,
        counterpartyIban: home.iban,
        description: source.description,
        reference: source.reference,
        referenceType: source.referenceType,
      })
      .where(eq(transactions.id, mirror.id))
      .run();
  }
  return linkAfterWrite(
    userId,
    source.accountId,
    [transactionId],
    [source.bookingDate],
    conn,
  );
}
