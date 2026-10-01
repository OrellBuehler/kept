<p align="center"><img src="static/brand/kept-lockup.svg" alt="Kept" height="64"></p>

Self-hosted personal finance. Import your accounts, match bills to payments and keep a balance
history — on your own server, in a single SQLite file.

## Features

- **Accounts** grouped by institution: current, savings, credit card, investment, pension, cash.
  Accounts you don't import can be tracked with manual balance snapshots.
- **Statement import** from ISO 20022 camt.053 (`.001.02`/`.04`/`.08` and later) and from any
  CSV or Excel export through a column mapping you set up once per account, with a live preview.
  Re-importing overlapping files never duplicates transactions; Kept warns when a file's opening
  balance doesn't continue the account's history. Every import can be undone.
- **Bills**: upload a PDF and Kept reads the Swiss QR-bill (falls back to the text when there is
  no QR code), or enter a bill by hand. Payments are matched by structured reference
  automatically, by IBAN and amount as a suggestion, or manually — including bills paid in parts,
  overpayments and credit notes awaiting a refund.
- **Dashboard**: net worth over time per currency (no currency conversion), this month's income
  and expenses, overdue and upcoming bills, and accounts whose last import is getting old.
- **PDF reports**: account statement, open bills, net worth.
- **Paperless-ngx (optional)**: pull bills from a tag or saved view, write amount, due date,
  reference and status back to custom fields, and file reports into Paperless.
- Local users with an admin who creates the others; every user only sees their own data.

eBill invoices can't be received directly by a self-hosted app. Download the invoice PDF in your
e-banking and upload it as a bill — the QR data is read from it.

## Run it

```bash
docker run -d --name kept -p 3000:3000 -v kept-data:/data \
  -e KEPT_SECRET_KEY="$(openssl rand -base64 32)" \
  -e ORIGIN=https://kept.example.org \
  ghcr.io/orellbuehler/kept:main
```

Open the app and create the first user at `/setup` — it becomes the administrator. Until that
happens, anyone who can reach the server can claim it, so do this right after starting it.

| Variable                      | Purpose                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KEPT_SECRET_KEY`             | Required. 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored integration tokens; keep it with your backups — changing it locks them. |
| `ORIGIN`                      | The public URL. Required behind a reverse proxy, otherwise form posts are rejected.                                                                    |
| `ADDRESS_HEADER`, `XFF_DEPTH` | Client address behind a proxy (e.g. `X-Forwarded-For`, `1`) so login rate limiting works per client.                                                   |
| `KEPT_COOKIE_SECURE=false`    | Only when serving over plain HTTP on a trusted network.                                                                                                |
| `DATABASE_PATH`               | Defaults to `/data/kept.db` in the image. Uploaded bills and pending imports live next to it.                                                          |

Back up the `/data` volume; it holds everything.

### Paperless-ngx

Paperless-ngx 2.16 or newer (2.18+ recommended). In Paperless create a dedicated user with view
and change permission on documents (plus view on tags, saved views, custom fields and tasks) and
an API token. Then in Kept open **Settings → Integrations**, enter the address and token, choose
the tag or saved view that holds your bills, and optionally map custom fields. Kept checks for new
documents every 30 minutes; for immediate imports add the Paperless workflow shown on that page
(trigger "Document Added", webhook action with the secret header). If Paperless runs with
`PAPERLESS_WEBHOOKS_ALLOW_INTERNAL_REQUESTS=false`, it can't call a Kept instance on a private
address — the periodic sync still works. Kept connects to whatever address you enter, including
private ones, so only give accounts to people you trust.

## Development

Requires [Bun](https://bun.sh) and [prek](https://github.com/j178/prek).

```bash
bun install
prek install
bun dev
bun run verify   # format, lint, typecheck, tests
```

Test fixtures are synthetic; never commit real statements or bills.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and other noncommercial use.
