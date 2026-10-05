import { and, eq, inArray, ne, or } from "drizzle-orm";
import { normalizeIban } from "$lib/iban";
import { minor } from "$lib/money";
import { transactions, transfers, first } from "$lib/server/db";
import {
  linkAfterWrite,
  loadPlanAccountsInTx,
  type LinkResult,
  type Tx,
} from "./link";
import {
  accountsByIban,
  canMirrorOnto,
  counterAmount,
  manualLinkIsConsistent,
  pairIsConsistent,
} from "./plan";

/**
 * Keeps the transfer of a manual transaction in step after it was edited
 * (`previousIban` is its counterparty IBAN before the edit): a mirror follows
 * the source's amount, dates and text; one that no longer fits is removed;
 * a changed counterparty forgets an earlier unlink. A pair or manual link with
 * another row that no longer fits (other amount, date, counterparty or sign)
 * is removed, both rows staying; a link that still fits stays. Then the row is
 * linked again where it can be.
 */
export async function resyncSource(
  tx: Tx,
  userId: string,
  transactionId: string,
  previousIban: string | null,
): Promise<LinkResult> {
  const source = await first(
    tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.id, transactionId),
        ),
      )
      .limit(1),
  );
  if (!source || source.source === "mirror") {
    return { paired: 0, mirrored: 0, needsAmount: 0 };
  }
  const ibanChanged =
    (previousIban === null ? null : normalizeIban(previousIban)) !==
    (source.counterpartyIban === null
      ? null
      : normalizeIban(source.counterpartyIban));

  const rows = await tx
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
    );
  const plan = await loadPlanAccountsInTx(tx, userId);
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
      // Only a dismissed mirror is about the IBAN: it is a new question when the
      // IBAN now names another account of the user. A dismissed pair names both rows.
      const dismissedTarget =
        t.outTransactionId === transactionId ? t.toAccountId : t.fromAccountId;
      if (
        ibanChanged &&
        mirrorId === null &&
        target !== undefined &&
        target.id !== dismissedTarget
      ) {
        await tx.delete(transfers).where(eq(transfers.id, t.id));
      }
      continue;
    }
    if (t.status === "needs_amount") {
      await tx.delete(transfers).where(eq(transfers.id, t.id));
      continue;
    }
    if (t.method !== "mirrored" && mirrorId !== null) {
      const peer = await first(
        tx
          .select()
          .from(transactions)
          .where(
            and(eq(transactions.userId, userId), eq(transactions.id, mirrorId)),
          )
          .limit(1),
      );
      const peerAccount = peer
        ? plan.find((a) => a.id === peer.accountId)
        : undefined;
      const fits =
        home !== undefined &&
        peer !== undefined &&
        peerAccount !== undefined &&
        (t.method === "manual"
          ? manualLinkIsConsistent(source, home, peer, peerAccount, plan)
          : pairIsConsistent(source, home, peer, peerAccount));
      if (!fits) await tx.delete(transfers).where(eq(transfers.id, t.id));
      continue;
    }
    if (t.method !== "mirrored" || mirrorId === null) continue;
    const mirror = await first(
      tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, mirrorId), eq(transactions.source, "mirror")),
        )
        .limit(1),
    );
    if (!mirror) continue;
    // Unknown for a foreign-currency mirror whose amount was entered by hand: it keeps that amount.
    const derived = target ? counterAmount(source, target) : null;
    const amount = derived ?? mirror.amount;
    if (
      !home ||
      !target ||
      amount === 0 ||
      target.id !== mirror.accountId ||
      Math.sign(amount) !== -Math.sign(source.amount) ||
      !canMirrorOnto(target, source.bookingDate)
    ) {
      await tx.delete(transactions).where(eq(transactions.id, mirror.id));
      continue;
    }
    await tx
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
      .where(eq(transactions.id, mirror.id));
    // The out side is the debit: a source that changed sign swaps the transfer's sides.
    const sourceIsOut = source.amount < 0;
    if ((t.outTransactionId === transactionId) !== sourceIsOut) {
      // The unique indexes on both columns rule out an in-place swap, so clear one side first.
      await tx
        .update(transfers)
        .set({ outTransactionId: null })
        .where(eq(transfers.id, t.id));
      await tx
        .update(transfers)
        .set({
          outTransactionId: t.inTransactionId,
          inTransactionId: t.outTransactionId,
          fromAccountId: t.toAccountId,
          toAccountId: t.fromAccountId,
        })
        .where(eq(transfers.id, t.id));
    }
  }
  return linkAfterWrite(
    tx,
    userId,
    source.accountId,
    [transactionId],
    [source.bookingDate],
  );
}

/**
 * After an account's IBAN changed: removes the automatic links of the account
 * that the new IBAN no longer supports. A mirror or pending amount needs its
 * source to name the receiving account; a pair needs both rows to still fit
 * (see `pairIsConsistent`). Links made by hand stay. Returns how many went.
 */
export async function revalidateLinks(
  tx: Tx,
  userId: string,
  accountId: string,
): Promise<number> {
  const plan = await loadPlanAccountsInTx(tx, userId);
  const byIban = accountsByIban(plan);
  const byId = new Map(plan.map((a) => [a.id, a]));
  const rows = await tx
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.userId, userId),
        ne(transfers.status, "dismissed"),
        ne(transfers.method, "manual"),
        or(
          eq(transfers.fromAccountId, accountId),
          eq(transfers.toAccountId, accountId),
        ),
      ),
    );
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.outTransactionId, r.inTransactionId])
        .filter((id): id is string => id !== null),
    ),
  ];
  const loaded = new Map<string, typeof transactions.$inferSelect>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const t of await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.id, ids.slice(i, i + 500)),
        ),
      )) {
      loaded.set(t.id, t);
    }
  }
  let removed = 0;
  for (const t of rows) {
    const out = t.outTransactionId ? loaded.get(t.outTransactionId) : undefined;
    const into = t.inTransactionId ? loaded.get(t.inTransactionId) : undefined;
    let valid: boolean;
    if (t.method === "paired") {
      const outAccount = out ? byId.get(out.accountId) : undefined;
      const inAccount = into ? byId.get(into.accountId) : undefined;
      valid =
        !!out &&
        !!into &&
        !!outAccount &&
        !!inAccount &&
        pairIsConsistent(out, outAccount, into, inAccount);
    } else {
      // Mirrored or waiting for an amount: the real row is the source, and it must name the receiving account.
      const source = out && out.source !== "mirror" ? out : into;
      const receiving = source === out ? t.toAccountId : t.fromAccountId;
      valid =
        !!source &&
        source.source !== "mirror" &&
        source.counterpartyIban !== null &&
        byIban.get(normalizeIban(source.counterpartyIban))?.id === receiving;
    }
    if (valid) continue;
    await tx.delete(transfers).where(eq(transfers.id, t.id));
    for (const m of [out, into]) {
      if (m?.source === "mirror") {
        await tx.delete(transactions).where(eq(transactions.id, m.id));
      }
    }
    removed += 1;
  }
  return removed;
}
