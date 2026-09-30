<p align="center"><img src="static/brand/kept-lockup.svg" alt="Kept" height="64"></p>

Self-hosted personal finance. Import your accounts, match bills to payments, see what the tax
office counted versus what you paid, and keep a balance history — on your own server, in a single
SQLite file.

> **Status:** early development. Nothing to install yet.

## Planned

- Accounts and transactions from ISO 20022 camt.053 files and configurable CSV/XLSX exports,
  with duplicate-safe re-imports
- Bills (upload a PDF or pull it from Paperless-ngx), QR-bill data extracted automatically,
  matched to the payment that settled them
- Tax payments per year reconciled against the tax office's statements
- Balance history and net worth, including accounts entered manually
- PDF reports that can be filed back into Paperless-ngx
- Local user accounts; Paperless-ngx is optional

## Development

Requires [Bun](https://bun.sh) and [prek](https://github.com/j178/prek).

```bash
bun install
prek install
bun dev
bun run verify   # format, lint, typecheck, tests
```

## Docker

```bash
docker run -d -p 3000:3000 -v kept-data:/data ghcr.io/orellbuehler/kept:main
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and other noncommercial use.
