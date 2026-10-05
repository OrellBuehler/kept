import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isQrIban } from "$lib/iban";
import type { Minor } from "$lib/money";
import type { PortfolioCloseReason } from "$lib/pillar-3a-types";
import { isValidQrr } from "$lib/references";
import {
  accounts,
  first,
  getDB,
  isUniqueViolation,
  pillar3aContributions,
  portfolios,
  portfolioValues,
  type DB,
} from "$lib/server/db";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import type { PortfolioCloseInput, PortfolioInput } from "./schemas";

export interface PortfolioView {
  id: string;
  accountId: string;
  name: string;
  number: string | null;
  strategy: string | null;
  /** Normalized QRR or SCOR that payments into the portfolio carry. */
  depositReference: string | null;
  openedOn: string | null;
  closedOn: string | null;
  closeReason: PortfolioCloseReason | null;
  sortOrder: number;
  /** Newest manually entered value, whether the portfolio is open or not. */
  latestValue: Minor | null;
  latestValueDate: string | null;
}

const columns = {
  id: portfolios.id,
  accountId: portfolios.accountId,
  name: portfolios.name,
  number: portfolios.number,
  strategy: portfolios.strategy,
  depositReference: portfolios.depositReference,
  openedOn: portfolios.openedOn,
  closedOn: portfolios.closedOn,
  closeReason: portfolios.closeReason,
  sortOrder: portfolios.sortOrder,
};

type Reader = Pick<DB, "select">;

/** Sync: the account must be the user's own and a pillar 3a account. Runs in the portfolio write transactions. */
function assertPillar3aAccount(tx: Reader, userId: string, accountId: string) {
  const account = tx
    .select({
      id: accounts.id,
      type: accounts.type,
      depositIban: accounts.depositIban,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .limit(1)
    .get();
  if (!account) throw notFound("Account");
  if (account.type !== "pillar_3a") {
    throw new LedgerError(
      "invalid",
      "Portfolios can only be added to a pillar 3a account.",
    );
  }
  return account;
}

async function withLatest(
  userId: string,
  rows: Omit<PortfolioView, "latestValue" | "latestValueDate">[],
): Promise<PortfolioView[]> {
  if (rows.length === 0) return [];
  const latest = new Map<string, { date: string; amount: Minor }>();
  for (const v of await getDB()
    .select({
      portfolioId: portfolioValues.portfolioId,
      date: portfolioValues.date,
      amount: portfolioValues.amount,
    })
    .from(portfolioValues)
    .where(
      and(
        eq(portfolioValues.userId, userId),
        inArray(
          portfolioValues.portfolioId,
          rows.map((r) => r.id),
        ),
      ),
    )) {
    const current = latest.get(v.portfolioId);
    if (!current || v.date > current.date) {
      latest.set(v.portfolioId, { date: v.date, amount: v.amount });
    }
  }
  return rows.map((r) => ({
    ...r,
    latestValue: latest.get(r.id)?.amount ?? null,
    latestValueDate: latest.get(r.id)?.date ?? null,
  }));
}

/** The user's portfolios (of one account when given), open ones first. */
export async function listPortfolios(
  userId: string,
  accountId?: string,
): Promise<PortfolioView[]> {
  if (accountId !== undefined)
    await assertPillar3aAccountOwned(userId, accountId);
  const rows = await getDB()
    .select(columns)
    .from(portfolios)
    .where(
      and(
        eq(portfolios.userId, userId),
        accountId ? eq(portfolios.accountId, accountId) : undefined,
      ),
    )
    .orderBy(
      sql`${portfolios.closedOn} is not null`,
      asc(portfolios.sortOrder),
      asc(portfolios.name),
      asc(portfolios.id),
    );
  return await withLatest(userId, rows);
}

async function assertPillar3aAccountOwned(userId: string, accountId: string) {
  const found = await first(
    getDB()
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1),
  );
  if (!found) throw notFound("Account");
}

export async function getPortfolio(
  userId: string,
  id: string,
): Promise<PortfolioView> {
  const row = await first(
    getDB()
      .select(columns)
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
      .limit(1),
  );
  if (!row) throw notFound("Portfolio");
  return (await withLatest(userId, [row]))[0]!;
}

/** A QR-IBAN takes only QR references, any other IBAN anything but. */
export function assertReferenceFits(
  depositIban: string | null,
  reference: string | null,
) {
  if (reference === null || depositIban === null) return;
  const qrIban = isQrIban(depositIban);
  const qrr = isValidQrr(reference);
  if (qrIban && !qrr) {
    throw new LedgerError(
      "invalid",
      "A QR-IBAN requires a QR reference (27 digits with a check digit).",
      "depositReference",
    );
  }
  if (!qrIban && qrr) {
    throw new LedgerError(
      "invalid",
      "A QR reference requires a QR-IBAN as the account's deposit IBAN.",
      "depositReference",
    );
  }
}

const referenceTaken = () =>
  new LedgerError(
    "conflict",
    "Another portfolio already uses this reference.",
    "depositReference",
  );

/** Sync: runs inside the transaction of createPortfolio / updatePortfolio. */
function assertReference(
  tx: Reader,
  userId: string,
  depositIban: string | null,
  reference: string | null,
  exceptId?: string,
) {
  if (reference === null) return;
  assertReferenceFits(depositIban, reference);
  const clash = tx
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(
      and(
        eq(portfolios.userId, userId),
        eq(portfolios.depositReference, reference),
      ),
    )
    .all()
    .find((r) => r.id !== exceptId);
  if (clash) throw referenceTaken();
}

/**
 * The in-transaction reference check is the friendly path; the unique index on
 * (user, reference) is the backstop when two writes race, and maps to the same error.
 */
function mapReferenceViolation(err: unknown, reference: string | null): never {
  if (reference !== null && isUniqueViolation(err)) throw referenceTaken();
  throw err;
}

function assertDates(openedOn: string | null, closedOn: string | null) {
  if (openedOn !== null && closedOn !== null && closedOn < openedOn) {
    throw new LedgerError(
      "invalid",
      "A portfolio cannot be closed before it was opened.",
      "closedOn",
    );
  }
}

export async function createPortfolio(
  userId: string,
  accountId: string,
  input: PortfolioInput,
): Promise<PortfolioView> {
  let id: string;
  try {
    id = getDB().transaction((tx) => {
      const account = assertPillar3aAccount(tx, userId, accountId);
      assertReference(tx, userId, account.depositIban, input.depositReference);
      const sortOrder =
        input.sortOrder ??
        (tx
          .select({ m: sql<number | null>`max(${portfolios.sortOrder})` })
          .from(portfolios)
          .where(
            and(
              eq(portfolios.userId, userId),
              eq(portfolios.accountId, accountId),
            ),
          )
          .get()?.m ?? -1) + 1;
      return tx
        .insert(portfolios)
        .values({ ...input, sortOrder, userId, accountId })
        .returning({ id: portfolios.id })
        .get().id;
    });
  } catch (err) {
    mapReferenceViolation(err, input.depositReference);
  }
  return await getPortfolio(userId, id);
}

export async function updatePortfolio(
  userId: string,
  id: string,
  input: PortfolioInput,
): Promise<PortfolioView> {
  try {
    getDB().transaction((tx) => {
      const current = tx
        .select({
          accountId: portfolios.accountId,
          closedOn: portfolios.closedOn,
          sortOrder: portfolios.sortOrder,
        })
        .from(portfolios)
        .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
        .limit(1)
        .get();
      if (!current) throw notFound("Portfolio");
      const account = assertPillar3aAccount(tx, userId, current.accountId);
      assertReference(
        tx,
        userId,
        account.depositIban,
        input.depositReference,
        id,
      );
      assertDates(input.openedOn, current.closedOn);
      const { sortOrder, ...rest } = input;
      tx.update(portfolios)
        .set({ ...rest, sortOrder: sortOrder ?? current.sortOrder })
        .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
        .run();
    });
  } catch (err) {
    mapReferenceViolation(err, input.depositReference);
  }
  return await getPortfolio(userId, id);
}

/** Ends the pension relationship: from `closedOn` on the portfolio no longer counts. */
export async function closePortfolio(
  userId: string,
  id: string,
  input: PortfolioCloseInput,
): Promise<PortfolioView> {
  getDB().transaction((tx) => {
    const current = tx
      .select({ openedOn: portfolios.openedOn })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
      .limit(1)
      .get();
    if (!current) throw notFound("Portfolio");
    assertDates(current.openedOn, input.closedOn);
    tx.update(portfolios)
      .set({ closedOn: input.closedOn, closeReason: input.closeReason })
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
      .run();
  });
  return await getPortfolio(userId, id);
}

export async function reopenPortfolio(
  userId: string,
  id: string,
): Promise<PortfolioView> {
  await getPortfolio(userId, id);
  await getDB()
    .update(portfolios)
    .set({ closedOn: null, closeReason: null })
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)));
  return await getPortfolio(userId, id);
}

/** Only possible while the portfolio has no values and no contributions; closing is the normal end. */
export async function deletePortfolio(
  userId: string,
  id: string,
): Promise<void> {
  getDB().transaction((tx) => {
    const found = tx
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
      .limit(1)
      .get();
    if (!found) throw notFound("Portfolio");
    const used =
      tx
        .select({ id: portfolioValues.id })
        .from(portfolioValues)
        .where(eq(portfolioValues.portfolioId, id))
        .limit(1)
        .get() ??
      tx
        .select({ id: pillar3aContributions.id })
        .from(pillar3aContributions)
        .where(eq(pillar3aContributions.portfolioId, id))
        .limit(1)
        .get();
    if (used) {
      throw new LedgerError(
        "conflict",
        "This portfolio has values or contributions. Close it instead of deleting it.",
      );
    }
    tx.delete(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
      .run();
  });
}
