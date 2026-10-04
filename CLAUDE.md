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
bun run test             # vitest (unit)
bun run test:coverage
bun run build && bun run start
bun run db:generate      # after editing src/lib/server/schema.ts
bun run leak-guard --all # scan the whole tree for private terms
bun run security         # semgrep, bun audit, trivy
```

Bun only — never npm, pnpm or yarn. Hooks run via prek: `prek install` once per clone.

## Stack

Bun · SvelteKit (`svelte-adapter-bun`) · TypeScript strict · Svelte 5 runes · Tailwind CSS v4 ·
shadcn-svelte (`$lib/components/ui/`, add with `bunx shadcn-svelte@latest add <name>`) ·
`@lucide/svelte` · Drizzle ORM on SQLite via `bun:sqlite` · Zod · Vitest · pdfmake for PDF
reports (no Typst, no headless browser).

## Architecture

```
src/lib/money.ts                 Minor-unit money type + parsing/formatting (the only way to handle amounts)
src/lib/server/db.ts             SQLite connection (WAL, foreign keys), migrations run on startup
src/lib/server/schema.ts         Drizzle schema — one file, every table has created_at/updated_at
src/lib/server/auth/             local users (Bun.password argon2id), sessions in SQLite
src/lib/server/importers/        file format → NormalizedStatement[] (pure, no DB access)
src/lib/server/imports/          upload → preview → confirm flow, history/undo, CSV mapping profiles
src/lib/server/ledger/           institutions, accounts, transactions, snapshots, balances
src/lib/server/bills/            bills, documents, QR-bill/PDF extraction, bill ↔ payment matching
src/lib/server/dashboard/        aggregate queries for the dashboard
src/lib/server/events.ts         generic in-process events (integrations subscribe; core emits)
src/lib/server/integrations/     optional adapters (paperless/) — the core never imports these
src/lib/server/reports/          pdfmake document builders
src/lib/{money,iban,references}.ts  client-safe helpers for amounts, IBANs, QRR/SCOR references
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
- **No swallowed errors.** No empty `catch`, no `catch { return null }` without logging and a
  user-visible outcome.
- Never log transaction descriptions, counterparties, IBANs or amounts.

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
