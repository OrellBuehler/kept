# Changelog

## Unreleased

### Added

- **Android and iOS apps**: the top-up IBAN (account form, account page, accounts list), "No new
  transactions" (account menu and next to the warning on the dashboard), the website link of
  institutions and accounts, and the reported gain and return of pillar 3a portfolios (update
  values, portfolio rows, value history, and the latest return of each portfolio on the pillar 3a
  screen).

## 0.7.0

### Added

- **MCP server** at `/api/mcp` (`docs/mcp.md`): an assistant that speaks the Model Context
  Protocol can read your data and, if you allow it, create and edit bills, match payments, set
  the category and note of a payment and manage categories and rules. It never changes the
  amount, date or existence of a bank transaction. Connect with an API token or by signing in
  (OAuth): the client opens a consent page where you choose the permissions.
- **Finer permissions for API tokens and connected apps**: separate read permissions for
  balances, budgets, forecast, investments, pillar 3a, taxes and the change log, write permissions
  for bills, matches, payments and categories, and a restriction to chosen accounts next to the
  one to categories. They apply to the external API as well.
- **Change log** (Settings → Change log): every change with who made it (you on the web, the app,
  an API token, an assistant, or Kept itself) and the values before and after. Changes to bills,
  matches, payment categories and notes, categories and rules can be reverted one by one, or all
  changes of one connection at once. A revert is refused when the data has changed since.
- **Connected apps** on the API tokens page: rename or revoke what you connected by signing in.
- **Top-up IBAN** for accounts without an IBAN of their own (e-money and card accounts): the
  IBAN you send money to when you top the account up, shown as such and not as the account's
  IBAN. A payment to it from another of your accounts is recognised as a transfer and linked to
  the credit on that account, or creates it when the account is filled from transfers. Web only
  for now; the apps keep the value when they edit an account.
- **"No new transactions"** on an account (account menu, and next to the warning on the
  dashboard): confirms that the account is up to date although there was nothing to import, for
  banks that issue no statement for a period without transactions. It quiets the "last import"
  warnings and the notification like an import does. Web only for now.
- **Sign in to the apps through the browser**: the apps open your server's login page in the
  system browser, where passkeys and password managers work as on the web, and you confirm there
  that the app may sign in. The password form stays.
- **Reported gain and return of pillar 3a portfolios**: the update values dialog takes the gain
  (CHF) and return (%) the provider reports next to the value. The account page shows them, the
  pillar 3a page charts each portfolio's return over time, and the MCP tool `get_pillar3a`
  returns them.
- **Website link** on institutions and accounts: an icon on the accounts list and the account
  page opens the account's portal, or the institution's when the account has none.
- **Why a bill suggestion is ambiguous**: a suggestion marked "Several matches" says whether the
  payment is also suggested for other bills, the bill has other suggested payments, or the payment
  went to a different account than the bill names ("Different account"). On the bills page the
  badge narrows the list to the competing matches.

### Changed

- A bill deleted through the API or by an assistant keeps its uploaded document for 30 days, so
  reverting the delete brings the document back.

### Fixed

- The CSV mapping step lays out row by row, so the preview of a wide file is no longer cut off.
- The forecast and net worth charts no longer draw their fill past the bottom of the chart when
  the axis does not start at zero.

- Bill matching: a payment of twice the open amount was suggested twice and never confirmed
  automatically; a bill stayed "paid" in an integration after its payment was deleted; payments
  up to five days before the matching window were not considered.

## 0.6.0

### Upgrading from 0.5.0

- **Set `ORIGIN` when Kept is reached over plain HTTP without a reverse proxy.** The server now
  assumes HTTPS unless `ORIGIN` says otherwise, and rejects logins and form posts from any other
  origin. Behind a reverse proxy `ORIGIN` was already required.
- **An empty `ORIGIN` is now an error** and stops the server at startup. Unset it or give a full
  `http://` or `https://` URL.
- `IDLE_TIMEOUT` is now `CONNECTION_IDLE_TIMEOUT`.
- On SIGTERM the server now waits for requests in flight (up to `SHUTDOWN_TIMEOUT`, 30 seconds by
  default) before it closes the database. Give the container at least that long to stop, or lower
  `SHUTDOWN_TIMEOUT`.

### Added

- **Apps for Android and iOS** (`mobile/`): native apps with the features of the web, for a server
  you host yourself. You enter the address of your server, then sign in with your Kept username
  and password (plus an authenticator or recovery code with two-step verification). The apps can
  remind you of bills that are due, budgets that are used up and accounts without a recent
  import; there is no push service, the app asks your server in the background. The Android APK
  is attached to the release once signing is set up; iOS is in TestFlight testing.
- **App API** under `/api/app/v1` for the apps (`docs/app-api.md`): sign-in with a bearer session,
  the data and actions of the pages the apps show, and `GET /reminders`. Nothing to configure;
  signing out or changing the password on the web ends the app's session.
- **Copy a CSV mapping from another account**: the column-mapping page offers the mappings saved
  for your other accounts. Applying one fills the form (with this account's currency as the
  default) and the preview checks it against the file before it is saved for this account.

### Changed

- Kept runs on SvelteKit 3 and the official `@sveltejs/adapter-bun`, which replaces the
  unmaintained `svelte-adapter-bun`.

## 0.5.0

### Upgrading from 0.4.0

- **Reverse proxies and CDNs must not cache `/sw.js` or `/workbox-*.js`.** Kept sends
  `Cache-Control: no-cache` for them; a proxy that caches them anyway keeps browsers on an old
  version after an upgrade.

### Added

- Installable app (PWA): a service worker precaches the static, content-hashed assets so the app
  loads faster, shows an offline page when the server cannot be reached, and offers to reload
  when a new version is available. Pages, data, documents and API responses are never cached in
  the browser.
- **camt.054 import** (debit/credit notifications, `.001.02`/`.04`/`.08` and later). A booking
  gets the same id as in camt.053, so a notification and a later statement never duplicate it.
  Notifications carry no balances; none are invented.
- **SWIFT MT940 import** (`.sta`, `.mt940`, `.txt`): multi-statement files, `:60F:`/`:60M:` and
  `:62F:`/`:62M:` balances, `:61:` with or without entry date and funds code, reversals (RC/RD),
  structured `:86:` (`?20`-`?29`, `?31`-`?33`, SEPA keywords such as EREF+/SVWZ+/IBAN+) and free
  text. Latin-1/windows-1252 files are decoded like CSV. The watch folder picks both formats up.

### Changed

- When a file holds several statements of one account whose closing balances share a date (also
  camt.053), the closing balance of the one later in the file is used. Pages of a multi-page MT940
  statement are merged by account number when they have no IBAN, and identical bookings on both
  sides of a page break are both imported.

## 0.4.0

### Upgrading from 0.3.0

- **Back up `kept.db` first.** Migrations 0017–0031 run automatically on the first start, in one
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
- External API for companion apps: scoped, revocable tokens (Settings → API tokens) with read
  access to bills, transactions, categories, recurring payments and accounts, and links back to
  bills and transactions. See `docs/external-api.md`.
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
