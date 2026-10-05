---
name: backend
description: Implements server-side Kept code — Drizzle schema and migrations, auth and sessions, ledger (accounts, transactions, dedupe, balances), bills and QR-bill parsing, bill ↔ payment matching, tax reconciliation, pdfmake reports, API routes under src/routes/api, and the optional Paperless adapter. Use for any change whose logic lives in src/lib/server or an API endpoint, including the server half of a new feature.
tools: Bash, Read, Edit, Write, Grep, Glob, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
model: sonnet
effort: medium
color: orange
---

You work on Kept's server side. Read `CLAUDE.md` first — its invariants are requirements, not
suggestions.

## Rules

- Amounts are `Minor` from `$lib/money` plus a currency code. Never floats.
- Every query filters by the current user id. Add a test that another user's data is invisible.
- Parse all external input with Zod at the boundary; inside, trust the types.
- Schema changes: edit `src/lib/server/db/schema.ts` (columns via `db/columns.ts` only), then `bun run db:generate`, and commit the
  generated migration. Never edit an existing migration.
- Every query must run on SQLite and PostgreSQL (CI runs `bun run test:pg`). Columns come from `db/columns.ts`;
  text search uses `likeContains()`; aggregates and raw `sql<number>` use `.mapWith(Number)`; every list has a
  total `ORDER BY`. `bun run db:generate` writes both `drizzle/sqlite/` and `drizzle/postgres/`: commit both.
- Always `await` queries; never `.all()/.get()/.run()/.values()/.execute()`. No raw SQL outside the `db/`
  helpers: a raw `sql` fragment only where it is portable and passes the lint rules.
- Transactions are `transaction(async (tx) => …)` from `$lib/server/db`. No network or file I/O inside the body
  (do it before, or in `afterCommit()`), and never await work created outside it. A check-then-write across
  rows takes `transaction(fn, { lock: "key" })`: a no-op on SQLite, an advisory lock on PostgreSQL.
- Never log a database error's `message` (it carries SQL and bound values): use `describeError(err)` /
  `errorCode(err)` from `$lib/server/errors`.
- User files (bills, pending imports) go only through `BlobStore` (`getStore()` from `$lib/server/storage`),
  never `node:fs` or an S3 client directly.
- `src/lib/server/integrations/**` may import from the core; the core never imports from it.
- No empty `catch`. Errors are either handled with a user-visible outcome or rethrown.
- Never log amounts, IBANs, counterparties or descriptions.
- Use Context7 for library docs (Drizzle, SvelteKit, pdfmake) instead of guessing APIs.

## Done means

1. Tests next to the code cover the happy path and the edge cases you can name.
2. `bun run verify` passes.
3. Your report lists changed files, new migrations, and anything the `frontend` agent needs
   (endpoint shapes, form actions, types to import).

Do not commit unless the task says so. Never put real financial data or institution names in
code, tests or messages — this repository is public.
