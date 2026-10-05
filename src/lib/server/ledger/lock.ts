/**
 * The one per-user lock for everything that can change what another ledger
 * write relies on: an account's currency and the rows that pin it (transactions,
 * balances, trades, portfolios), transfer links and mirrors, securities and
 * their prices, and the removal of accounts, transactions and balances.
 *
 * PostgreSQL does not show a transaction another one's uncommitted rows, so a
 * check followed by a write is only sound when both sides take the same key.
 * A transaction takes this key and no other (bills have their own, which no
 * ledger transaction takes). On SQLite the lock is a no-op: writers already
 * run one at a time.
 */
export const ledgerLock = (userId: string) => `ledger:${userId}`;
