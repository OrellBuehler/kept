# External API

Kept has a small, token-authenticated JSON API for companion apps you run yourself, for example a
household app that shows apartment costs and open bills next to its own data. It is read-mostly:
an app can read bills, transactions, categories, recurring payments and account names, and attach
links (such as "open in my app") to bills and transactions. It cannot create or change anything else.

Everything lives under `/api/external/v1/`. Nothing else in Kept accepts a token, and nothing under
that prefix accepts a login session.

## Create a token

Open **Settings → API tokens**, choose a name, tick the permissions the app needs, optionally limit
the transactions it may see to some categories and set an expiry, confirm with your password (and
your authenticator code if you use one), and copy the token. Kept shows it once and stores only a
hash; if you lose it, revoke it and create another.

A token looks like `kept_` followed by 43 characters. Treat it like a password: it grants exactly the
permissions you ticked, to the data of the user who created it, until it expires or is revoked.
Revoke a token on the same page the moment an app no longer needs it.

## Authenticate

Send the token as a bearer token:

```bash
export KEPT=https://kept.example.org
export TOKEN=kept_…

curl -sS -H "Authorization: Bearer $TOKEN" "$KEPT/api/external/v1/me"
```

- Only the `Authorization: Bearer` header counts. Cookies are ignored under `/api/external/v1/`,
  and a bearer token is ignored everywhere else.
- Use HTTPS. Kept is usually behind a reverse proxy; set `ORIGIN` to the public URL (it is also the
  base of the `url` fields below).
- Browsers cannot call the API from another site: it sends no CORS headers. Call it from a server.

## Permissions (scopes)

| Scope               | Allows                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| `bills:read`        | `GET /bills`, `GET /bills/{id}`, `GET /bills/{id}/links`                            |
| `transactions:read` | `GET /transactions`, `GET /transactions/{id}`, `GET /transactions/{id}/links`       |
| `recurring:read`    | `GET /recurring-series`                                                             |
| `categories:read`   | `GET /categories`                                                                   |
| `accounts:read`     | `GET /accounts`                                                                     |
| `links:write`       | `POST /bills/{id}/links`, `POST /transactions/{id}/links`, `DELETE /links/{linkId}` |

`GET /me` needs a valid token but no scope. A token without the scope an endpoint needs gets `403`.

**Category restriction.** A token can be limited to chosen categories. It then only sees
transactions in those categories (a transaction in any other category, or without one, answers
`404`, as does attaching a link to it) and only those categories. Recurring series are detected
across all categories, so a category-restricted token cannot read them (`403`, and the settings page
refuses the combination). Bills and accounts are not tied to a category and stay readable with
their scope; a bill's `paidAmount` counts payments in any category.

## Conventions

- **Format.** JSON in and out. A `POST` body needs `Content-Type: application/json`.
- **Money.** `amount` is an integer in minor units of `currency` (for CHF and EUR: cents). Never a
  float. Transaction amounts are signed from your point of view: outgoing is negative.
- **Dates.** Calendar dates are `YYYY-MM-DD`. `updatedAt` and `createdAt` are ISO 8601 UTC instants.
- **Ids** are opaque strings. Rows of other users do not exist for a token: they answer `404`.
- **Pagination.** Lists answer `{ "items": [...], "nextCursor": string | null }`. Pass `limit`
  (1 to 200, default 50) and, to get the next page, `cursor` set to the previous `nextCursor`. A
  cursor is opaque; a missing `nextCursor` (`null`) means the last page. Order is fixed per
  endpoint, so paging never skips or repeats a row that did not change meanwhile.
- **`updatedSince`.** Lists accept an ISO 8601 timestamp with offset (`2026-10-01T00:00:00Z`) and
  return rows changed at or after it. It is inclusive: compare ids if you store the newest
  `updatedAt` you saw. Deleted rows simply disappear; to notice deletions, list the open set again.
- **Errors.** Always `{ "message": "..." }` with the status below. Messages are for people; match
  on the status.
- **Rate limit.** 120 requests per minute per token, then `429` with a `Retry-After` header
  (seconds). Repeated rejected tokens from one address are also answered with `429`.
- **No caching.** Responses carry `Cache-Control: no-store`.

| Status  | Meaning                                                                 |
| ------- | ----------------------------------------------------------------------- |
| 400     | Invalid query parameter, cursor or body                                 |
| 401     | Missing, malformed, revoked or expired token                            |
| 403     | The token lacks the scope the endpoint needs                            |
| 404     | No such row for this token's user (or outside its category restriction) |
| 405     | Method not allowed on this path                                         |
| 409     | A link limit was reached (20 per bill or transaction)                   |
| 413/415 | Request body too large / not `application/json`                         |
| 429     | Rate limit; wait `Retry-After` seconds                                  |

## Endpoints

### `GET /me`

```json
{
  "id": "…",
  "username": "alice",
  "displayName": "Alice",
  "locale": "de-CH",
  "defaultCurrency": "CHF",
  "token": { "scopes": ["bills:read"], "categoryIds": null }
}
```

### `GET /bills` and `GET /bills/{id}`

Query: `status`, `dueFrom`, `dueTo` (`YYYY-MM-DD`, inclusive; bills without a due date are left out
when either is set), `updatedSince`, `cursor`, `limit`. Ordered by due date, earliest first,
undated bills last.

`status` filters like the bill list in Kept and takes one value or a comma-separated list:

| Value       | Bills                                                      |
| ----------- | ---------------------------------------------------------- |
| `open`      | unpaid or partly paid, not yet overdue                     |
| `overdue`   | due before today and still unpaid or partly paid           |
| `paid`      | settled                                                    |
| `refund`    | a credit note still to be received, or an overpaid invoice |
| `cancelled` | cancelled                                                  |
| `all`       | everything (the default)                                   |

```json
{
  "id": "…",
  "kind": "invoice",
  "creditorName": "Example Supplier AG",
  "amount": 12345,
  "currency": "CHF",
  "issueDate": "2026-09-01",
  "dueDate": "2026-10-01",
  "invoiceNumber": "INV-2026-17",
  "status": "partially_paid",
  "overdue": true,
  "paidAmount": 5000,
  "remainingAmount": 7345,
  "lastPaymentDate": "2026-09-20",
  "notes": null,
  "url": "https://kept.example.org/bills/…",
  "updatedAt": "2026-09-20T08:15:00.000Z"
}
```

- `kind`: `invoice` or `credit_note`.
- `amount`: minor units, always positive, `null` for a bill without a fixed amount.
- `status` is computed from the payments allocated to the bill, exactly as in the app: `open`,
  `partially_paid`, `paid`, `overpaid`, `credit_due` or `cancelled`. `overdue` is true when the bill
  is due before today and still `open` or `partially_paid`.
- `paidAmount` is the sum of the allocated payments; `remainingAmount` is `null` without a fixed
  amount.
- `updatedAt` covers the bill and its payment allocations. Removing an allocation does not move it,
  so for "what is still open" prefer listing `status=open,overdue` over syncing by `updatedSince`.
- The creditor's IBAN and the payment reference are never part of the API.

### `GET /transactions` and `GET /transactions/{id}`

Query: `from`, `to` (booking date, `YYYY-MM-DD`, inclusive), `categoryId`, `accountId`, `q`
(case-insensitive text in description or counterparty name, up to 100 characters),
`updatedSince`, `cursor`, `limit`. Newest booking date first.

```json
{
  "id": "…",
  "accountId": "…",
  "bookingDate": "2026-09-20",
  "amount": -5000,
  "currency": "CHF",
  "counterpartyName": "Example Supplier AG",
  "description": "Invoice INV-2026-17",
  "categoryId": "…",
  "billIds": ["…"],
  "url": "https://kept.example.org/accounts/…?tx=…",
  "updatedAt": "2026-09-20T08:15:00.000Z"
}
```

`billIds` are the bills the transaction is allocated to. `updatedAt` also moves when a payment is
allocated to a bill (removing an allocation does not move it). The counterparty's IBAN, references and
notes are never part of the API. With a category-restricted token, `categoryId` must be one of its
categories (anything else returns an empty list).

### `GET /categories`

Query: `updatedSince`, `cursor`, `limit`. Ordered by name.

```json
{
  "id": "…",
  "name": "Housing",
  "parentId": null,
  "kind": "expense",
  "color": "#2a9d8f",
  "updatedAt": "2026-01-02T10:00:00.000Z"
}
```

`parentId` is `null` for a top-level category, and for a subcategory whose parent a restricted
token may not see.

### `GET /recurring-series`

Query: `status` (`suggested`, `confirmed`, `dismissed`; default all), `updatedSince`, `cursor`,
`limit`. Ordered by the next expected date.

```json
{
  "id": "…",
  "status": "confirmed",
  "name": "Example Streaming",
  "cadence": "monthly",
  "currency": "CHF",
  "amount": -1500,
  "monthlyCost": -1500,
  "annualCost": -18000,
  "firstDate": "2025-01-05",
  "lastDate": "2026-09-05",
  "lastAmount": -1500,
  "occurrences": 21,
  "nextExpected": "2026-10-05",
  "overdue": false,
  "updatedAt": "2026-09-06T04:00:00.000Z"
}
```

### `GET /accounts`

Query: `updatedSince`, `cursor`, `limit`. Names and types only: no IBANs and no balances.

```json
{
  "id": "…",
  "name": "Everyday",
  "currency": "CHF",
  "type": "current",
  "archived": false,
  "updatedAt": "2026-01-02T10:00:00.000Z"
}
```

`type` is one of `current`, `savings`, `credit_card`, `investment`, `pension`, `pillar_3a`, `cash`,
`other`.

## Links

A companion app can attach links to a bill or a transaction. Kept shows them on the bill page and in
the transaction details as "Linked: label (host)", opening in a new tab. Labels and sources may not
contain control or invisible formatting characters.

### `GET /bills/{id}/links`, `GET /transactions/{id}/links`

Needs the matching read scope. Answers `{ "items": [link, …] }`.

### `POST /bills/{id}/links`, `POST /transactions/{id}/links`

Needs `links:write`.

```bash
curl -sS -X POST "$KEPT/api/external/v1/bills/$BILL_ID/links" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"home app","label":"Apartment costs 2026","url":"https://home.example.org/costs/2026"}'
```

| Field    | Rules                                                                           |
| -------- | ------------------------------------------------------------------------------- |
| `source` | Which app this is, up to 64 characters. Part of the link's identity.            |
| `label`  | Text shown in Kept, up to 200 characters, no control characters.                |
| `url`    | Absolute `http` or `https` URL, up to 2048 characters, no embedded credentials. |

Answers `201` with the link, or `200` when the same entity, `source` and `url` already exist (the
label is updated): posting twice is safe. Kept normalises the URL, so `https://Example.org` and
`https://example.org/` are one link. At most 20 links per bill or transaction.

```json
{
  "id": "…",
  "entityType": "bill",
  "entityId": "…",
  "source": "home app",
  "label": "Apartment costs 2026",
  "url": "https://home.example.org/costs/2026",
  "createdAt": "2026-10-06T12:00:00.000Z"
}
```

### `DELETE /links/{linkId}`

Needs `links:write`. Answers `204`. A token can delete any link of its user, including those other
apps created; ids of other users' links answer `404`.

## Example: open bills

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$KEPT/api/external/v1/bills?status=open,overdue&limit=100" | jq '.items[] | {creditorName, dueDate, remainingAmount, url}'
```

Following pages:

```bash
cursor=$(curl -sS … | jq -r .nextCursor)
curl -sS -H "Authorization: Bearer $TOKEN" "$KEPT/api/external/v1/bills?cursor=$cursor&limit=100"
```

## Security notes

- Tokens are stored as SHA-256 hashes, are random (32 bytes), and are never logged. Each use
  updates "last used" at most once a minute; revoking takes effect on the next request.
- Every query is scoped to the user who owns the token. Another user's rows are indistinguishable
  from missing rows.
- Tokens are independent of your login: changing your password or signing out does not revoke
  them. Revoke them on the API tokens page after a suspected leak.
- Creating a token needs your password (and a second factor if enabled); revoking needs only a
  click. Token creation and revocation are recorded in the security audit trail (ids only).
- Responses never contain IBANs, payment references or the notes of transactions. Bill notes are
  included in `GET /bills`; leave them empty if they hold anything an app should not see, or do not
  grant `bills:read` to that app.
- Links are rendered as plain anchors with `rel="noopener noreferrer"`, and only `http` and `https`
  URLs are ever stored.
