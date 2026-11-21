# App API contract fixtures

One file per bridged page of the app API (`GET /api/app/v1/pages/…`), plus `session`, `server`
and `reminders`: the exact response body, captured from the synthetic dataset in
`src/lib/testing/app-contract.ts`. The mobile apps' DTOs are written and tested against these
files, and `src/routes/api/app/v1/contract.test.ts` fails when a web change removes or retypes a
field they contain (it compares the shape, not the values).

- Everything here is invented: "Example" names, documented example IBANs, meaningless amounts.
  Ids, dates and amounts change on every capture.
- A field that is `null` in a file may hold a value elsewhere: see the other captures of the same
  page (`accounts.id.*`, `bills.id.*`).
- Secrets in page data are replaced by `REDACTED…` placeholders (the list is in the test).
- After an intended, additive change to page data, regenerate with
  `UPDATE_APP_CONTRACT=1 bun run test src/routes/api/app/v1/contract.test.ts` and commit the diff.
