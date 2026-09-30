# CSV fixtures

Every file in this folder is **synthetic**: hand-written or produced by `generate.ts`. They use
made-up counterparties, "Example Bank" and documented example IBANs. Never add a real export,
not even trimmed or anonymized.

`windows-1252-umlauts.csv`, `utf8-bom.csv` and `utf16le-bom.csv` are binary-encoded and are
produced by `bun src/lib/testing/fixtures/csv/generate.ts`.
