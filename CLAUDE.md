# CLAUDE.md — Kept

Kept is a self-hosted personal finance app: accounts and their transactions, bills matched to
payments, tax payments reconciled against what the tax office counted, and balance history.
Paperless-ngx is an optional integration, never a requirement.

## This repository is public

- **Never commit real financial data.** No real account numbers, IBANs, card numbers, statement
  exports, amounts from real documents, names of the maintainer's banks, employers, addresses or
  people. Test fixtures are synthetic and live in `src/lib/testing/fixtures/`; use documented
  example IBANs only.
- **Code is format-based, not institution-based.** Importers are named after file formats
  (`camt053`, `csv`), never after a bank. Institution-specific CSV column mappings are user
  configuration stored in the database, not code.
- The `leak-guard` hook blocks locally configured private terms (`.private-terms`, gitignored).
  If it fires, remove the data — never weaken the hook or add the term to a tracked file.
- Commit messages and PR texts follow the same rules. Never mention AI tools in them.

## Commands

```bash
bun dev                  # dev server
bun run verify           # format:check + lint + check + test — run before every commit
bun run format           # prettier --write
bun run lint:fix         # eslint --fix
bun run check            # svelte-kit sync + svelte-check
bun run test             # vitest (unit, SQLite)
bun run test:coverage
bun run test:pg          # the suite on PostgreSQL (needs KEPT_TEST_DATABASE_URL; CI runs it too)
bun run build && bun run start
bun run db:generate      # after editing src/lib/server/db/schema.ts: writes drizzle/sqlite and drizzle/postgres
                         # (db:generate:sqlite / db:generate:pg for one dialect)
bun run leak-guard --all # scan the whole tree for private terms
bun run security         # semgrep, bun audit, trivy
```

Bun only — never npm, pnpm or yarn. Hooks run via prek: `prek install` once per clone.

## Stack

Bun · SvelteKit (`svelte-adapter-bun`) · TypeScript strict · Svelte 5 runes · Tailwind CSS v4 ·
shadcn-svelte (`$lib/components/ui/`, add with `bunx shadcn-svelte@latest add <name>`) ·
`@lucide/svelte` · Drizzle ORM on SQLite (`bun:sqlite`, the default) or PostgreSQL 17+ (`Bun.SQL`) ·
files on disk or in S3 (`Bun.S3Client`) · Zod · Vitest · pdfmake for PDF
reports (no Typst, no headless browser).

## Architecture

```
src/lib/money.ts                 Minor-unit money type + parsing/formatting (the only way to handle amounts)
src/lib/server/db/index.ts       facade: getDB() (resolves the open transaction), transaction({ lock }), afterCommit(), first(), isUniqueViolation(), likeContains(); runs migrations on startup
src/lib/server/db/sqlite.ts      SQLite backend (bun:sqlite, WAL, foreign keys) behind a FIFO gate (gate.ts): one connection, one transaction at a time
src/lib/server/db/postgres.ts    PostgreSQL backend (Bun.SQL pool, advisory locks, migration lock)
src/lib/server/db/config.ts      readDatabaseConfig(): DATABASE_URL / DATABASE_PATH / KEPT_DB_*, validated with Zod
src/lib/server/db/dialect.ts     which dialect this process uses ("sqlite" | "pg"), from DATABASE_URL; no bun: imports (drizzle-kit loads it)
src/lib/server/db/columns.ts     dialect-switched schema builders — the only way to declare columns
src/lib/server/db/schema.ts      Drizzle schema — one file, written with columns.ts; every table has created_at/updated_at
src/lib/server/db/search.ts      escapeLike(), likeContains(): portable case-insensitive text search
src/lib/server/storage/          BlobStore (put/get/has/delete/list) for user files: fs.ts (default), s3.ts, config.ts (KEPT_STORAGE*, KEPT_S3_*), getStore()
src/lib/server/auth/             local users (Bun.password argon2id), sessions in the database
src/lib/server/importers/        file format → NormalizedStatement[] (pure, no DB access)
src/lib/server/imports/          upload → preview → confirm flow, history/undo, CSV mapping profiles
src/lib/server/ledger/           institutions, accounts, transactions, snapshots, balances
src/lib/server/bills/            bills, documents, QR-bill/PDF extraction, bill ↔ payment matching
src/lib/server/dashboard/        aggregate queries for the dashboard
src/lib/server/events.ts         generic in-process events (integrations subscribe; core emits)
src/lib/server/integrations/     optional adapters (paperless/) — the core never imports these
src/lib/server/reports/          pdfmake document builders
src/lib/{money,iban,references}.ts  client-safe helpers for amounts, IBANs, QRR/SCOR references
drizzle/{sqlite,postgres}/       generated migrations, one folder per dialect (never edit by hand)
src/routes/                      UI + API (`src/routes/api/`)
src/lib/testing/fixtures/        synthetic sample files for importer tests
```

## Invariants

- **Money is `Minor` (integer minor units) plus an ISO 4217 currency code.** Never floats, never
  `Number(amountString)`. Parse with `parseAmount`, format with `formatAmount`.
- **Booking/value dates are `YYYY-MM-DD` strings**; instants are `timestamp_ms` integers.
- **Importers are pure**: `(file contents, options) → NormalizedTransaction[]`. Each result
  carries a stable `externalId` (bank reference, or a hash of the raw row when the file has none)
  so re-importing overlapping files never duplicates transactions.
- **Every query is scoped to the current user.** No endpoint returns another user's data.
- **External input is parsed with Zod** (forms, API bodies, imported files, integration payloads).
- **Paperless is an adapter.** Nothing outside `integrations/paperless/` knows about Paperless;
  a bill may reference a Paperless document id, but works without one.
- **Transactions are `transaction(async (tx) => …)` from `$lib/server/db`.** Inside, `getDB()` resolves to
  the same `tx`; a nested call is a savepoint. Await every query. **No network or file I/O inside a
  transaction body** (the whole database waits behind it, FIFO): do I/O before it, or in `afterCommit()`,
  which also carries events (`emitBillChanged`) and log lines that must only follow a commit. CPU-heavy work
  (detection, hashing) runs outside too: read, compute, then a short transaction that re-checks and writes.
  **Never await a promise or query builder that was created outside the current transaction from inside
  its body**: if it needs the database it queues behind the transaction that is waiting for it, and both
  hang until the gate timeout. `afterCommit` hooks are awaited before `transaction()` returns, so keep
  them short; long I/O belongs in a detached task the hook starts. Work still running when a transaction
  rolls back fails ("rolled back") instead of writing outside it, savepoints started side by side run one
  after the other, and a transaction open longer than the watchdog (60 s) is rolled back by the database layer
  (PostgreSQL: `transaction_timeout`, `KEPT_DB_TRANSACTION_TIMEOUT_MS`).
- **Always await queries.** Builders are awaited, never run with `.all()/.get()/.run()/.values()/.execute()`;
  a forgotten `await` drops the query. Lint enforces both (`no-floating-promises` with `checkThenables`,
  `kept/no-query-terminals`, by receiver type).
- **No raw SQL outside the `db/` helpers.** Use drizzle builders and `likeContains()`, `first()`, `alias`. A raw
  `sql` fragment is allowed only when it is portable and passes `kept/no-pg-only-api` (the lint rule lists
  what is banned); dialect-specific SQL belongs in `db/`.
- **User files go only through `BlobStore`** (`getStore()` from `$lib/server/storage`): uploaded bills and
  pending imports are never written with `node:fs` or an S3 client directly, so both storage backends
  keep working. The watch folder and scheduled SQLite backups are the only other code that touches user files on disk.
- **Queries must run on SQLite and PostgreSQL.** Columns come from `db/columns.ts` only; PostgreSQL-only
  drizzle APIs and `::` casts in raw SQL are banned by lint outside `db/`. Aggregates and raw
  `sql<number>` go through `.mapWith(Number)` (PostgreSQL returns int8 and numeric as strings), and a
  timestamp is read as a Date column (`max(col)`), never as a raw `sql<number>`. Text search uses
  `likeContains()`, not `like`; SQLite-only functions (`strftime`, `ifnull`, `group_concat`, scalar
  `min/max`, `char`, `rowid`) are banned by lint. A cross-row invariant (check, then write across rows)
  takes `transaction(fn, { lock })`: a no-op on SQLite, an advisory lock on PostgreSQL. One key per
  transaction (enforced in tests): ledger, transfer, import, trade and snapshot writes share
  `ledgerLock` (`ledger/lock.ts`), bills and allocations `billsLock`. Every list a
  user sees has a total `ORDER BY`. Migrations: `bun run db:generate` writes both `drizzle/sqlite/` and
  `drizzle/postgres/` (never edit either by hand except for data fix-ups); `DATABASE_URL=postgres://…`
  selects PostgreSQL (see `db/config.ts`). `bun run test:pg` runs the whole suite on PostgreSQL
  (`KEPT_TEST_DATABASE_URL=postgres://…` to a server of its own; each test file gets a database cloned
  from a migrated template), and CI runs it on every push. Tests that only make sense on SQLite say why.
- **No swallowed errors.** No empty `catch`, no `catch { return null }` without logging and a
  user-visible outcome.
- Never log transaction descriptions, counterparties, IBANs or amounts.
- Never log the `message` of a database error: drizzle's `DrizzleQueryError` carries the SQL and the bound
  values (password hashes, TOTP secrets). Log `describeError(err)` / `errorCode(err)` from `$lib/server/errors`.

## Svelte 5

Runes only: `$state`, `$derived`, `$effect`, `$props`, `{@render children()}`. No `export let`,
no `$:`, no `<slot />`, no stores for component state. Use Tailwind classes and `cn()` from
`$lib/utils`; no component CSS files.

## Testing

- Unit tests sit next to the code (`foo.ts` → `foo.test.ts`).
- Importers and matching are tested against synthetic fixtures covering edge cases: overlapping
  files, missing references, foreign currencies, reversals, negative amounts.
- Bug fixes start with a failing test.

## Subagents (`.claude/agents/`)

| Agent        | Scope                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| `backend`    | schema, migrations, auth, ledger, bills, matching, reports, API routes, Paperless adapter |
| `importer`   | file-format parsers + their synthetic fixtures and tests                                  |
| `frontend`   | Svelte pages and components, forms, tables, charts                                        |
| `reviewer`   | read-only review of a change against these invariants and the privacy rules               |
| `researcher` | read-only research on external systems, standards and APIs; returns a cited report        |

Split a feature by layer: backend first (with tests), then frontend, then `reviewer`.

## Git

Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`).
Run `bun run verify` before committing. Never commit `.private-terms`, `.env` or anything in `data/`.
