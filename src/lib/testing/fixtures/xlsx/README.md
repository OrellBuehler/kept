# XLSX fixtures

Every file in this folder is **synthetic**. The workbooks are produced by `generate.ts` from the
builder in `build.ts`, so the binaries are reproducible (fixed timestamps). Regenerate with
`bun src/lib/testing/fixtures/xlsx/generate.ts`. Never add a real export, not even trimmed or
anonymized.
