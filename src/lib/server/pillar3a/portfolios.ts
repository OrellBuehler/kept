import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isQrIban } from "$lib/iban";
import type { Minor } from "$lib/money";
import type { PortfolioCloseReason } from "$lib/pillar-3a-types";
import { isValidQrr } from "$lib/references";
import {
  accounts,
  getDB,
  pillar3aContributions,
  portfolios,
  portfolioValues,
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

/** The account must be the user's own and a pillar 3a account. */
function assertPillar3aAccount(userId: string, accountId: string) {
  const account = getDB()
    .select({
      id: accounts.id,
      type: accounts.type,
      depositIban: accounts.depositIban,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
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

function withLatest(
  userId: string,
  rows: Omit<PortfolioView, "latestValue" | "latestValueDate">[],
): PortfolioView[] {
  if (rows.length === 0) return [];
  const latest = new Map<string, { date: string; amount: Minor }>();
  for (const v of getDB()
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
    )
    .all()) {
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
export function listPortfolios(
  userId: string,
  accountId?: string,
): PortfolioView[] {
  if (accountId !== undefined) assertPillar3aAccountOwned(userId, accountId);
  const rows = getDB()
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
    )
    .all();
  return withLatest(userId, rows);
}

function assertPillar3aAccountOwned(userId: string, accountId: string) {
  const found = getDB()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
    .get();
  if (!found) throw notFound("Account");
}

export function getPortfolio(userId: string, id: string): PortfolioView {
  const row = getDB()
    .select(columns)
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
    .get();
  if (!row) throw notFound("Portfolio");
  return withLatest(userId, [row])[0]!;
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

function assertReference(
  userId: string,
  depositIban: string | null,
  reference: string | null,
  exceptId?: string,
) {
  if (reference === null) return;
  assertReferenceFits(depositIban, reference);
  const clash = getDB()
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
  if (clash) {
    throw new LedgerError(
      "conflict",
      "Another portfolio already uses this reference.",
      "depositReference",
    );
  }
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

export function createPortfolio(
  userId: string,
  accountId: string,
  input: PortfolioInput,
): PortfolioView {
  const account = assertPillar3aAccount(userId, accountId);
  assertReference(userId, account.depositIban, input.depositReference);
  const db = getDB();
  const sortOrder =
    input.sortOrder ??
    (db
      .select({ m: sql<number | null>`max(${portfolios.sortOrder})` })
      .from(portfolios)
      .where(
        and(eq(portfolios.userId, userId), eq(portfolios.accountId, accountId)),
      )
      .get()?.m ?? -1) + 1;
  const row = db
    .insert(portfolios)
    .values({ ...input, sortOrder, userId, accountId })
    .returning({ id: portfolios.id })
    .get();
  return getPortfolio(userId, row.id);
}

export function updatePortfolio(
  userId: string,
  id: string,
  input: PortfolioInput,
): PortfolioView {
  const current = getPortfolio(userId, id);
  const account = assertPillar3aAccount(userId, current.accountId);
  assertReference(userId, account.depositIban, input.depositReference, id);
  assertDates(input.openedOn, current.closedOn);
  const { sortOrder, ...rest } = input;
  getDB()
    .update(portfolios)
    .set({ ...rest, sortOrder: sortOrder ?? current.sortOrder })
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
    .run();
  return getPortfolio(userId, id);
}

/** Ends the pension relationship: from `closedOn` on the portfolio no longer counts. */
export function closePortfolio(
  userId: string,
  id: string,
  input: PortfolioCloseInput,
): PortfolioView {
  const current = getPortfolio(userId, id);
  assertDates(current.openedOn, input.closedOn);
  getDB()
    .update(portfolios)
    .set({ closedOn: input.closedOn, closeReason: input.closeReason })
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
    .run();
  return getPortfolio(userId, id);
}

export function reopenPortfolio(userId: string, id: string): PortfolioView {
  getPortfolio(userId, id);
  getDB()
    .update(portfolios)
    .set({ closedOn: null, closeReason: null })
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
    .run();
  return getPortfolio(userId, id);
}

/** Only possible while the portfolio has no values and no contributions; closing is the normal end. */
export function deletePortfolio(userId: string, id: string): void {
  getPortfolio(userId, id);
  const db = getDB();
  const used =
    db
      .select({ id: portfolioValues.id })
      .from(portfolioValues)
      .where(eq(portfolioValues.portfolioId, id))
      .get() ??
    db
      .select({ id: pillar3aContributions.id })
      .from(pillar3aContributions)
      .where(eq(pillar3aContributions.portfolioId, id))
      .get();
  if (used) {
    throw new LedgerError(
      "conflict",
      "This portfolio has values or contributions. Close it instead of deleting it.",
    );
  }
  db.delete(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.id, id)))
    .run();
}
