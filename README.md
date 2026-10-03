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
- **Categories and budgets**: your own income and expense categories (one level of
  subcategories), rules that categorize transactions on import (counterparty, description, IBAN,
  direction) and can be re-run on uncategorized ones, a category you set by hand always wins, and
  monthly budgets per category showing spent against budget, per currency.
- **Dashboard**: net worth over time per currency (no currency conversion), this month's income
  and expenses, overdue and upcoming bills, and accounts whose last import is getting old.
- **Taxes**: mark transactions and bills with a tax year, enter the lines from the tax office's
  statement and the assessed total, and see per year what you paid against what they counted —
  missing lines, amount differences and the remaining balance (amount due or refund).
- **PDF reports**: account statement, open bills, net worth, tax reconciliation.
- **Paperless-ngx (optional)**: pull bills from a tag or saved view, write amount, due date,
  reference and status back to custom fields, and file reports into Paperless.
- **Notifications**: per user, choose triggers (bill due within N days, bill overdue, monthly
  budget reaching X%, account not imported for N days) and channels (ntfy, signed webhook, email).
  Checked hourly; each event is sent once. Set up under Settings → Notifications.
- Local users with an admin who creates the others; every user only sees their own data.

eBill invoices can't be received directly by a self-hosted app. Download the invoice PDF in your
e-banking and upload it as a bill — the QR data is read from it.

## Run it

```bash
docker run -d --name kept -p 3000:3000 -v kept-data:/data \
  -e KEPT_SECRET_KEY="$(openssl rand -base64 32)" \
  -e ORIGIN=https://kept.example.org \
  ghcr.io/orellbuehler/kept:latest
```

Open the app and create the first user at `/setup` — it becomes the administrator. Until that
happens, anyone who can reach the server can claim it, so do this right after starting it.

| Variable                               | Purpose                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEPT_SECRET_KEY`                      | Required. 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored integration tokens; keep it with your backups — changing it locks them.                                                                                                                                                      |
| `ORIGIN`                               | The public URL. Required behind a reverse proxy, otherwise form posts are rejected.                                                                                                                                                                                                                         |
| `ADDRESS_HEADER`, `XFF_DEPTH`          | Client address behind a proxy (e.g. `X-Forwarded-For`, `1`) so login rate limiting works per client.                                                                                                                                                                                                        |
| `KEPT_COOKIE_SECURE=false`             | Only when serving over plain HTTP on a trusted network.                                                                                                                                                                                                                                                     |
| `DATABASE_PATH`                        | Defaults to `/data/kept.db` in the image. Uploaded bills and pending imports live next to it.                                                                                                                                                                                                               |
| `KEPT_BACKUP_DIR`                      | Optional. Writes a daily database backup into this directory (e.g. `/data/backups`).                                                                                                                                                                                                                        |
| `KEPT_BACKUP_KEEP`                     | How many scheduled backups to keep; older ones are deleted. Defaults to `7`.                                                                                                                                                                                                                                |
| `KEPT_INBOX_DIR`                       | Optional. Enables the watch-folder import, e.g. `/data/inbox` (see below).                                                                                                                                                                                                                                  |
| `KEPT_INBOX_INTERVAL`                  | Seconds between inbox scans (5 to 86400). Defaults to `60`.                                                                                                                                                                                                                                                 |
| `KEPT_SMTP_HOST`                       | Optional. SMTP server for the email notification channel; the channel is only offered when this and `KEPT_SMTP_FROM` are set.                                                                                                                                                                               |
| `KEPT_SMTP_FROM`                       | Sender address for notification emails, e.g. `Kept <kept@example.org>`.                                                                                                                                                                                                                                     |
| `KEPT_SMTP_PORT`                       | Defaults to `587` (STARTTLS when offered).                                                                                                                                                                                                                                                                  |
| `KEPT_SMTP_SECURE`                     | `true` for implicit TLS, `false` otherwise. Defaults to `true` on port 465, else `false`.                                                                                                                                                                                                                   |
| `KEPT_NOTIFY_BLOCK_PRIVATE`            | Optional. `true` makes ntfy and webhook destinations that resolve to loopback, private (RFC1918), unique-local, link-local or unspecified addresses fail, at save and send time. Off by default so a LAN ntfy works; turn it on for multi-user instances where users should not reach the internal network. |
| `KEPT_SMTP_USER`, `KEPT_SMTP_PASSWORD` | Optional SMTP login.                                                                                                                                                                                                                                                                                        |

### Watch-folder import

Set `KEPT_INBOX_DIR` and Kept scans it on start and every `KEPT_INBOX_INTERVAL` seconds. Every
user has a folder named after their username (created on the first scan). The process needs
write access to the directory.

```
<inbox>/<username>/statement.xml        camt.053: account found by the statement IBAN
<inbox>/<username>/<account>/export.csv CSV or Excel: account named by the folder
<inbox>/<username>/processed/           imported (or already known) files
<inbox>/<username>/review/              files waiting for you on the Import page
<inbox>/<username>/failed/              rejected files, each with a `.reason.txt`
```

- The folder `<account>` is the account's name (case-insensitive) or its IBAN. CSV and Excel
  files also need the column mapping saved for that account (map one file by hand once); without
  it the file waits in `review/`. A camt.053 file placed in an account folder is imported into
  that account, and the usual IBAN check still applies.
- Files go through the same preview and confirm path as uploads: duplicates are skipped, and the
  import shows up in history and can be undone. A file is imported automatically only when the
  account is unambiguous and the preview has no warnings (for example a balance gap). Otherwise
  it waits in `review/`; open the Import page and press **Review** to continue as a normal upload.
- A file is never processed twice: files are identified by SHA-256. A repeat is moved to
  `processed/`. A file from `failed/` is retried when you drop it in again.
- Files modified in the last 10 seconds, hidden files and other extensions (`.part`, `.pdf`) are
  left alone. Supported: `.xml`, `.csv`, `.txt`, `.xlsx`, up to 20 MB.
- The Import page shows the last scan and recent auto-imports, reviews and failures.

### Backup and restore

The database holds everything (including institution logos) except uploaded bill PDFs, which live next to it in
`/data/documents`. Back up the whole `/data` volume, and keep `KEPT_SECRET_KEY` with it.

- **Download:** the administrator can download a consistent copy of the database under
  **Backup** in the sidebar. It is taken with SQLite's `VACUUM INTO`, so it is safe while Kept is
  running.
- **Scheduled:** set `KEPT_BACKUP_DIR` to write `kept-backup-YYYYMMDD-HHMMSS.db` once a day
  (checked hourly, first run a minute after start) and keep the newest `KEPT_BACKUP_KEEP`. The
  directory should be on a different disk or synced elsewhere, otherwise it does not protect
  against losing the volume.

Restoring is done on the server, because the database file must not be replaced while Kept runs:

```bash
docker stop kept
# replace the database; remove the old WAL files so they are not applied to the restored file
docker run --rm -v kept-data:/data -v "$PWD":/backup alpine sh -c \
  'rm -f /data/kept.db-wal /data/kept.db-shm && cp /backup/kept-backup-20260101-030000.db /data/kept.db && chown 1001:1001 /data/kept.db'
docker start kept
```

Restore a backup taken by the same or an older version of Kept; pending migrations run on start.
A backup from a newer version than the running image is not supported. Restore the matching
`documents` folder too if bills must show their PDFs, and use the same `KEPT_SECRET_KEY`,
otherwise stored integration tokens can't be decrypted. Check that you can sign in before deleting
the volume's previous contents.

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
