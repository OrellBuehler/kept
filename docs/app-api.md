# App API

The API of Kept's own mobile apps, under `/api/app/v1/`. It gives a signed-in user what the web
gives them, as JSON. It is not a general integration API: for companion apps and scripts use the
token-authenticated [external API](external-api.md), which is small, scoped and stable by design.

## Authentication

An app signs in with the user's password (and second factor), or through the browser, and gets a
session token, which it sends as a bearer token:

```bash
export KEPT=https://kept.example.org

curl -sS "$KEPT/api/app/v1/server"
curl -sS -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"…"}' "$KEPT/api/app/v1/auth/login"
curl -sS -H "Authorization: Bearer $TOKEN" "$KEPT/api/app/v1/session"
```

- Only `Authorization: Bearer <session token>` counts under the prefix. Cookies are never read
  there, a session token as bearer token is ignored everywhere else, and an API token (`kept_…`)
  is not a session.
- The session is the same kind the web uses: 30 days, extended while it is used, ended by
  `auth/logout`, by a password change or by an administrator.
- Sign-in shares the web's rate limits (`429` with a `Retry-After` header). A bearer that cannot
  be a session token (wrong length or characters) counts against its address: after 20 of them
  in 15 minutes that address is answered `429` with `Retry-After`. A well-formed token that
  matches no session (ended, expired or unknown) is just `401`, however often it is sent.
- Responses carry `Cache-Control: no-store`, and errors are always `{ "message": "…" }`.

| Endpoint                   | Auth    | Purpose                                                                                                                                |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /server`              | none    | `{ app: "kept", version, apiLevel, setupRequired }`: lets an app check the address before asking for a password                        |
| `POST /auth/login`         | none    | `{ username, password }` → `{ status: "ok", token, expiresAt, user }` or `{ status: "second_factor", pendingToken, expiresAt, totp }`  |
| `POST /auth/verify`        | none    | `{ pendingToken, code }` (authenticator or recovery code) → `{ status: "ok", token, expiresAt, user }`; `410` when the sign-in expired |
| `POST /auth/browser`       | none    | Starts a sign-in through the browser → `{ request, secret, path, expiresAt }`, see below                                               |
| `POST /auth/browser/token` | none    | `{ request, secret }` → `{ status: "ok", token, expiresAt, user }`; `409` until the user approved, `410` when it expired or was used   |
| `POST /auth/logout`        | session | Ends the session the request was made with                                                                                             |
| `GET /session`             | session | `{ user, today, overdueBills, preferences, twoFactor, sessionExpiresAt }`                                                              |
| `GET /reminders`           | session | What a device should notify about, see below                                                                                           |
| `GET /pages/<page>`        | session | A page's data                                                                                                                          |
| `POST /pages/<page>`       | session | A page's form action, named by `?_action=`                                                                                             |
| `GET /endpoints/…`         | session | Files the web serves, and its JSON previews (`POST` for the ones that take a body)                                                     |

**Sign-in through the browser.** The app's own form takes a password and a code. For everything
else the web offers (passkeys, a password manager that fills in by web address) the app lets the
server's login page do the work:

1. `POST /auth/browser` answers a public `request` id, a `secret` that stays in the app, and the
   `path` to open (`/login/app?request=…`). The request lives for ten minutes.
2. The app opens that path on the server in a browser (`ASWebAuthenticationSession`, a Custom Tab).
   The user signs in as on the web and confirms that the app may sign in as them.
3. The page sends the browser to `ch.orellbuehler.kept://signin?request=…&code=…`, which brings
   the app back with a one-time `code`.
4. `POST /auth/browser/token` with `request`, `secret` and `code` answers the session, once. The
   session is a new one of its own, independent of the one in the browser.

Neither half is worth anything alone. Another app that catches the return address has the code
but no `secret`. Someone who starts a request and talks a user into approving the link has the
`secret`, but the `code` only reaches the device the approval happened on. With the password form,
an account that has only passkeys signs in with a recovery code (`totp` is `false` then).

## Pages

The bridge runs the `load` function and the form actions of the web pages
(`src/routes/(app)/**/+page.server.ts`), so the apps can do what the web can without a second set
of handlers. The pages are listed in `src/routes/api/app/v1/registry.ts`; the path under `/pages/`
is the web path (`/pages/dashboard` for `/`). Pages that hand out or manage credentials (security
settings, API tokens), the integrations and the administrator pages are not bridged: the apps
open those in the browser.

**Data.** `GET /pages/bills/<id>?…` answers `{ "data": … }` with what the page's `load` returns:
dates as ISO 8601 strings, amounts as integers in minor units. The query string is the one the
web page reads. A page that sends the browser elsewhere answers `{ "redirect": "/import/…" }`
instead. A missing row is `404`.

**Actions.** `POST /pages/bills/<id>?_action=allocate` with `Content-Type: application/json` and
the form as a JSON object: every value is what the HTML form would send, a string or a list of
strings for a repeated field; `null` means "not sent". A file is
`{ "$file": { "name": "bill.pdf", "type": "application/pdf", "base64": "…" } }`.

```json
{ "ok": true, "data": { "success": true }, "redirect": "/bills/…" }
```

`redirect` is present when the web page navigates after the action. A refused form (validation,
conflict) answers the action's status (usually `400`) with

```json
{
  "ok": false,
  "message": "Enter an amount.",
  "data": { "errors": { "amount": ["Enter an amount."] }, "values": {} }
}
```

where `data.errors` is keyed by form field (`form` for errors that belong to no field).

**Endpoints.** `GET /endpoints/bills/<id>/document`, `/endpoints/reports/<kind>?…`,
`/endpoints/institutions/<id>/logo` answer the file as the web does;
`POST /endpoints/imports/<pendingId>/preview` and `GET /endpoints/pillar-3a/buy-in-check`
are the JSON previews the web's forms use.

## The contract

Released apps depend on the shape of every page's data and on the fields of its actions, so
**page data and action fields change additively only**: add fields, never remove or retype one,
and keep an action's field names. `src/routes/api/app/v1/contract.test.ts` enforces the first
half: it loads every page for a synthetic dataset and compares the shape with the fixtures in
`src/lib/testing/fixtures/app-contract/`, which the apps' models are tested against. After an intended, additive
change regenerate them:

```bash
UPDATE_APP_CONTRACT=1 bun run test src/routes/api/app/v1/contract.test.ts
```

`apiLevel` in `GET /server` is raised when an app has to know that something was added.

## Reminders

`GET /reminders?billDueDays=3&billOverdue=true&budgetPercent=100&staleImportDays=14` evaluates the
same triggers as the server's notification channels, with the thresholds the device asks for (a
parameter that is left out switches that reminder off):

```json
{
  "today": "2026-10-01",
  "events": [
    {
      "key": "bill-overdue:…:2026-09-20",
      "kind": "bill-overdue",
      "title": "Bill overdue",
      "body": "Example Supplier AG (CHF 123.45) was due on 2026-09-20 (11 days ago)."
    }
  ],
  "bills": [
    {
      "id": "…",
      "creditorName": "Example Supplier AG",
      "invoiceNumber": null,
      "remaining": 12345,
      "currency": "CHF",
      "dueDate": "2026-10-05"
    }
  ]
}
```

`events` is what is worth a notification now; `key` is stable, so a device shows each key once.
`bills` are the open bills with a due date, for notifications the device schedules ahead. The
server sends nothing to Apple or Google: the apps poll this endpoint and notify locally.
