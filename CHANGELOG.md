# Changelog

## 0.4.0

### Upgrading from 0.3.0

- **Back up `kept.db` first.** Migrations 0017–0029 run automatically on the first start, in one
  transaction (a failure leaves the database as it was). Two of them rewrite existing rows.
- **Finish or cancel open imports before upgrading.** Uploads waiting for confirmation now live in
  the database and blob store; previews started on 0.3.0 are not carried over.
- **Tax payments may move to a different deduction year.** Outflows mapped to a deduction that
  have no matching line on the tax statement are reclassified. The tax year page lists the moved
  payments and lets you undo or dismiss the change.
- **Email notifications are limited to administrators.** Users have no verified address yet, so
  a member's existing email channel now fails with "limited to administrators". Use ntfy or a
  webhook instead.
- **Members can no longer reach private network addresses** (webhooks, ntfy, Paperless) unless
  you set `KEPT_ALLOW_PRIVATE_NETWORK=true`. Administrators still can.
  `KEPT_NOTIFY_BLOCK_PRIVATE=true` blocks them for everyone.
- **`KEPT_SECRET_KEY` is required by every built server**, not only with `NODE_ENV=production`.
  The Docker image already required it; `bun run start` without it now refuses to start. Use
  `KEPT_ALLOW_INSECURE_KEY=true` only for throwaway local runs.
- **Stored tokens that cannot be decrypted** (for example after changing the key) are now flagged
  as needing re-entry in settings instead of failing on use.
- **Admin actions ask for your password** (and second factor, when enabled) and are recorded in
  an audit log.
- SQLite migrations moved from `drizzle/` to `drizzle/sqlite/`. Only relevant if you run Kept
  from source with your own paths; already applied migrations are recognised.

### Added

- Investments: securities, trades, holdings valuation, stock splits, and daily prices and FX
  rates from Yahoo Finance.
- Pillar 3a: portfolios, values and contributions, yearly limits and buy-in rules, overview page
  and tax summary.
- Transfers between own accounts, linked on import and manual entry, with mirrored transactions.
- Liquidity: notice periods, liquid cash and invested totals.
- PostgreSQL (17+) as an alternative to SQLite, via `DATABASE_URL`, and S3-compatible blob
  storage via `KEPT_STORAGE=s3`.
- Several instances can share one PostgreSQL database: scheduled jobs and cleanups run on one
  instance, and every instance shuts down gracefully.
- Security headers and a content security policy; app error pages.
- Warning about lost edits before undoing an import.

### Fixed

- Bills: editing a payment can no longer over-allocate it, and removed allocations are not
  re-added by automatic matching.
- Pillar 3a: late payments capped per year, refunds subtracted, portfolios not counted twice.
- Imports: confirm re-checks the preview under the ledger lock; inbox imports match bills again;
  expired uploads are cleaned up reliably.
- Outgoing requests: private-address checks cannot be bypassed through DNS, and saved tokens are
  not sent to a changed host.
- Login throttling per username and per client (IPv6 by /64), without hard-locking a username.
- Many concurrency fixes around bills, transfers, categories and notification settings.

### New environment variables

`DATABASE_URL`, `KEPT_DB_POOL_MAX`, `KEPT_DB_PREPARE`, `KEPT_DB_STATEMENT_TIMEOUT_MS`,
`KEPT_DB_TRANSACTION_TIMEOUT_MS`, `KEPT_DB_APPLICATION_NAME`, `KEPT_STORAGE`, `KEPT_STORAGE_DIR`,
`KEPT_S3_*`, `KEPT_ALLOW_PRIVATE_NETWORK`, `KEPT_ALLOW_INSECURE_KEY`.
See the README for details.
