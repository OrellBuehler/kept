# MCP server

Kept has a built-in [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI
assistant such as Claude Code or Claude Desktop can look at your bills and payments and, if you
allow it, tidy them up: match payments to bills, file payments under categories, add notes.

A client connects in one of two ways: by **signing in** in your browser (OAuth, below), or with an
**API token** from **Settings → API tokens**, the same token system as the
[external API](external-api.md). Either way you tick what it may do, and every action is limited to
that. The server lives at one URL:

```
POST https://kept.example.org/api/mcp
```

It speaks MCP's Streamable HTTP transport in stateless mode: every request stands alone, answers
with plain JSON, and there is no session to keep alive. `GET` and `DELETE` answer `405` (there is
no server-pushed stream and no session to close).

## What the assistant sees

Everything a tool returns is sent to the AI provider your client talks to, and a model reads it as
text. Kept therefore gives a connection only what its permissions allow, and never returns IBANs,
payment references, document files, settings or other users' data. Amounts are decimal strings in
the currency's own precision (`"-12.50"` for CHF, outgoing payments negative), dates are
`YYYY-MM-DD`, and lists page with `limit` and `cursor`.

## Create a token

1. Open **Settings → API tokens → Create token**.
2. Name it after the client (`Claude Code, laptop`).
3. Tick the permissions (below). Start with read permissions only.
4. Optionally limit it to chosen accounts and/or categories, and set an expiry.
5. Confirm with your password (and authenticator code) and copy the token. Kept shows it once.

A token looks like `kept_` followed by 43 characters and is the same kind of token the external API
uses: one token can work on both surfaces, with the same permissions and restrictions.

## Connect a client

Claude Code:

```bash
claude mcp add --transport http kept https://kept.example.org/api/mcp \
  --header "Authorization: Bearer kept_…"
```

Any client that supports remote HTTP servers with a header (generic JSON configuration):

```json
{
  "mcpServers": {
    "kept": {
      "type": "http",
      "url": "https://kept.example.org/api/mcp",
      "headers": { "Authorization": "Bearer kept_…" }
    }
  }
}
```

Ask the assistant to call `whoami` first: it lists what the connection may do, its restrictions and
the tools it has. A tool the token has no permission for is not listed at all.

## Connect with sign-in (OAuth)

A client that follows the MCP authorization specification (Claude Code, the MCP inspector, other
local tools) can ask for your permission in the browser instead of you copying a token. Claude Code:

```bash
claude mcp add --transport http kept https://kept.example.org/api/mcp
```

Then run `/mcp` inside Claude Code, pick `kept` and choose **Authenticate**. Your browser opens
Kept's consent page (sign in first if you are not): check it and press **Allow**. The client
registers itself, receives a short-lived access token and a refresh token, and keeps both.

**What the consent page asks.** It names the application (the name it gave itself: Kept cannot
check it) and the address your browser is sent back to, and warns when that is not this computer.
The permissions the application asked for are ticked; if it asked for nothing, every read
permission is ticked and no write permission. You can tick or untick any permission, restrict it to
accounts and categories and set an expiry, exactly as for an API token (the same rules apply).
Granting any permission that changes data asks for your password (and authenticator code), as
creating a token does, and the page says plainly that an assistant with write permissions can change
your data, that changes are recorded and that you can revert them. **Deny** tells the application
`access_denied`.

**Lifetimes.** An access token lasts one hour. The refresh token is replaced every time it is used
and lapses after 30 days without use; presenting an already used refresh token revokes the whole
connection (a copy of it leaked). If you set an expiry, the connection ends then. Access tokens work
at `/api/mcp` only, never on the REST API, and only for the address they were issued for.

**Home network.**

- The browser you sign in with and the client must both reach Kept's address. Hosted assistants
  (a vendor's cloud) cannot reach a server at home; local tools can, and they receive the result on
  a loopback address of their own computer, which never leaves it.
- Set `ORIGIN` to the address the clients use. Every URL in the metadata and the audience of the
  tokens come from it; with it unset Kept uses the address of the request (and assumes https on
  plain http). A token is refused at any other address than the one it was issued for.
- Plain `http://` on a LAN address works, but access tokens and authorization codes then travel
  unencrypted. Use https beyond a network you trust.
- Behind a reverse proxy, pass `/api/mcp`, `/oauth/` and `/.well-known/` through and keep the
  `Authorization` header.

**Managing connections.** **Settings → API tokens → Connected apps** lists each connected app with
its permissions, restrictions, last use and expiry, and revokes it: it stops working at once and
has to ask you again. The client can also revoke itself (RFC 7009). Deleting a user deletes their
connections. A password change does **not** end connections, as it does not end API tokens: revoke
them if you suspect a leak.

**API token or sign-in?** Prefer a token for scripts, for clients that cannot do OAuth, when you
need the REST API as well, or when you want one fixed secret in a configuration file. Prefer sign-in
for interactive tools: no secret to copy, short-lived tokens and an easy revoke.

**Protocol notes.** OAuth 2.1 authorization code with mandatory PKCE (S256), resource indicators
(RFC 8707), protected resource metadata (RFC 9728, linked from the 401 challenge), authorization
server metadata (RFC 8414), the `iss` response parameter (RFC 9207), dynamic client registration of
public clients (RFC 7591) and token revocation. Registration is open but bounded: 10 per address and
hour, at most 200 clients, unused clients are removed after 24 hours (when the limit is reached the
oldest client nobody has connected through makes room; registration is refused only when every
client has a connection), and every field is validated. A request that cannot be answered to a
client's registered `https` address (a malformed request, before you saw the consent page) shows an
error page instead of sending your browser there; only a loopback address is told the error. After
you pressed **Allow** or **Deny** the browser goes to the registered address; without JavaScript the
page shows a **Continue** link for it.
If the browser says an application is "not registered", remove the server in the client and add it
again. Redirect URIs are `https` (exact match) or `http` on `localhost`, `127.0.0.1` or `[::1]` (any
port). Client ID Metadata Documents are not supported: they make the server fetch an address the
client chooses, which is a risk on a home network. The metadata, registration, token and revocation
endpoints answer with `Access-Control-Allow-Origin: *` and never with credentials (they use no
cookie); the consent page has no CORS and cannot be framed.

| Path                                                    | Purpose                          |
| ------------------------------------------------------- | -------------------------------- |
| `/.well-known/oauth-protected-resource` and `…/api/mcp` | resource metadata                |
| `/.well-known/oauth-authorization-server`               | authorization server metadata    |
| `/oauth/register`, `/oauth/token`, `/oauth/revoke`      | called by the client, no session |
| `/oauth/authorize`                                      | consent, needs your session      |

## Permissions and tools

| Scope                              | Tools                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (any valid token)                  | `whoami`                                                                                                                                                |
| `bills:read`                       | `list_bills`, `get_bill`                                                                                                                                |
| `bills:read` + `transactions:read` | `list_match_suggestions`, `list_payment_candidates`                                                                                                     |
| `transactions:read`                | `list_transactions`, `get_transaction`                                                                                                                  |
| `accounts:read`                    | `list_accounts` (names and types only)                                                                                                                  |
| `categories:read`                  | `list_categories`, `list_category_rules`                                                                                                                |
| `balances:read`                    | `get_balances`, `get_net_worth`                                                                                                                         |
| `budgets:read`                     | `get_budgets`                                                                                                                                           |
| `recurring:read`                   | `list_recurring_payments`                                                                                                                               |
| `forecast:read`                    | `get_forecast`, `list_planned_items`                                                                                                                    |
| `investments:read`                 | `get_investments`                                                                                                                                       |
| `pillar3a:read`                    | `get_pillar3a`                                                                                                                                          |
| `taxes:read`                       | `list_tax_years`, `get_tax_year`                                                                                                                        |
| `changes:read`                     | `list_changes` (this connection's own changes)                                                                                                          |
| `bills:write`                      | `create_bill`, `update_bill`, `set_bill_cancelled`, `delete_bill`                                                                                       |
| `matches:write`                    | `allocate_payment`, `remove_allocation`, `dismiss_suggestion`, `run_auto_match`                                                                         |
| `transactions:write`               | `update_transaction`, `update_transactions` (category and note of a payment, up to 50 at once)                                                          |
| `categories:write`                 | `create_category`, `update_category`, `delete_category`, `create_category_rule`, `update_category_rule`, `delete_category_rule`, `apply_category_rules` |
| `changes:revert`                   | `revert_change`, `revert_changes` (this connection's own changes; implies `changes:read`)                                                               |
| `links:write`                      | none: this permission is for the external REST API only                                                                                                 |

A tool that needs two permissions needs both. Tools are annotated for the client:
`list_*`/`get_*` are read-only; `delete_bill`, `remove_allocation`, `delete_category`,
`delete_category_rule`, `apply_category_rules` and the two `revert_*` tools are marked destructive,
and the client may ask you before it runs them.

**A tool returns another permission's data only when the connection holds that permission too.**
Without `transactions:read` a bill's allocations carry only the allocation id, amount and payment id
(no booking date, counterparty or account), `update_transaction` answers with the payment's `id`,
`categoryId` and `note` only, and the tax reconciliation leaves out counterparties. Without
`bills:read` `list_transactions` and `get_transaction` leave out `billIds` (and refuse the
`unmatched` filter), `update_bill` and `set_bill_cancelled` answer with the bill's id, and the
forecast hides the names of bill-based items. Without `accounts:read` balances, the forecast,
investments and pillar 3a give account ids but not names (and balances not types). Without
`categories:read` budgets give category ids but not names and `update_category` answers with the
id. `list_changes` shows an entry's short label (a creditor, counterparty or category name) only
when the connection may also read that kind of data. Search follows the same rule: `list_bills`
searches creditor, invoice number, notes and exact amount, and `list_payment_candidates` counterparty,
description and amount, never the IBAN, reference or message, which no tool returns.

What the write tools can **not** do: create, delete or change the amount, date or counterparty of a
bank transaction (a payment's category and note are all `transactions:write` touches), touch
imports, uploaded files, backups, users, settings, API tokens or the Paperless connection.

## Restrictions

A token can be limited to some **accounts** and/or some **categories**. For payments, accounts and
categories a restricted token behaves as if the rest did not exist: a payment outside answers "not
found" (never "forbidden"), lists leave it out, and writes to it are refused. **Bills are the
exception.** A bill is not tied to an account or a category, so with `bills:read` a restricted
token still sees every bill, and each bill's `paidAmount`, `remainingAmount`, status and
`lastPaymentDate` count the payments allocated to it in **any** account and category, including
ones the token cannot see; `ambiguous` on a match suggestion can likewise stem from a payment it
cannot see. The allocations a bill lists are only those of visible payments. Kept shows a note
about this on the token form and on the consent page when a restriction is combined with
`bills:read`. If that is too much, do not give the token `bills:read`.

| Data                                                                                   | Account restriction                                                                                                                                                                                                               | Category restriction                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Payments (list, get, filters)                                                          | only payments of those accounts                                                                                                                                                                                                   | only payments in those categories; uncategorized ones are invisible                                                       |
| Accounts, balances                                                                     | only those accounts and their totals                                                                                                                                                                                              | `balances:read` refused (balances are not split by category)                                                              |
| Categories, `list_category_rules`                                                      | all categories; rules hidden (they name counterparties of every account)                                                                                                                                                          | only those categories and their rules                                                                                     |
| Match candidates and suggestions                                                       | only payments of those accounts (`ambiguous` may stem from a payment it cannot see)                                                                                                                                               | only payments in those categories                                                                                         |
| `allocate_payment`, `dismiss_suggestion`, `remove_allocation`, `update_transaction(s)` | the payment must be in those accounts                                                                                                                                                                                             | the payment must be in those categories; it may only be filed under those categories, and its category may not be cleared |
| `run_auto_match`                                                                       | confirms only payments of those accounts                                                                                                                                                                                          | confirms only payments in those categories                                                                                |
| Bills                                                                                  | readable; `paidAmount` and status count payments of every account; allocations list only visible payments; an expected account must be one of those accounts; `delete_bill` is refused while payments it cannot see are allocated | readable; `paidAmount` counts payments in any category                                                                    |
| `get_investments`                                                                      | only holdings of those accounts                                                                                                                                                                                                   | `investments:read` refused                                                                                                |
| `get_net_worth`                                                                        | tool hidden (a total over all accounts)                                                                                                                                                                                           | `balances:read` refused                                                                                                   |
| Recurring payments, budgets, forecast and planned items, pillar 3a, taxes              | scope refused: they aggregate across all accounts                                                                                                                                                                                 | scope refused: they aggregate across all categories                                                                       |
| `categories:write` (categories and rules)                                              | scope refused: rules apply to payments of every account                                                                                                                                                                           | scope refused: the category tree and its rules apply to everything                                                        |

"Scope refused" means: the settings page does not let you combine them, token creation fails with
the reason, and a token that somehow holds such a combination loses the scope when it is used
(`whoami` shows what is left). Both restrictions can be combined: a payment must satisfy both.
An unrestricted token sees everything of its owner, and nothing of any other user, ever.

The same restrictions apply to the external REST API: a token behaves the same on both surfaces.

## The change log and reverting

Every change made through MCP is recorded in Kept's change log with the connection's name and the
kind `mcp`, in the same database transaction as the change itself, so it can be told apart from
your own changes and reverted from there like any other. `changes:read` lets the assistant list the entries **its own connection**
made (without amounts or other values: action, entity, a short label, the fields that changed), and
`changes:revert` lets it revert them. A connection can never see or revert what you, another
connection or the web app changed. Reverting is refused, with the reason, when the data was changed
afterwards in a way that undoing would lose.

**Deleting a bill keeps its document.** What an assistant does is meant to be revertible in full, so
when an API token or an MCP connection deletes a bill, its uploaded invoice file is **not** removed
along with it. Kept holds the document for 30 days; reverting the delete in the change log attaches
it to the restored bill again. After 30 days a sweep (hourly) removes the file if no bill uses it
(a document a bill references again is never removed). A bill you delete yourself in the web app
removes its document at once, as before; reverting that delete restores the bill without the
document and says so.

## Security notes

- **Use HTTPS** and keep the token secret: treat it like a password. Anyone with it can do exactly
  what its permissions allow, until it expires or you revoke it (on the same settings page).
- **Home network.** Kept is often reachable only inside a home network. The endpoint validates the
  `Origin` header, as the MCP specification requires against DNS rebinding: a request from a browser
  page of another site is refused with `403`. Requests without an `Origin` header (every normal MCP
  client) are fine; with one, it must be your instance's `ORIGIN` or listed in
  `KEPT_MCP_ALLOWED_ORIGINS` (comma-separated). **Set `ORIGIN`.** Without it Kept has no address of
  its own to compare with (the request's own `Host` header is chosen by the caller, so it proves
  nothing) and refuses every request that carries an `Origin` unless it is listed. The metadata
  documents and the audience of OAuth tokens also fall back to the request's address without
  `ORIGIN`. The consent page does not depend on it: it needs your session cookie, which a rebound
  host name never carries.
- **Browser-based clients are not supported.** `/api/mcp` sends no CORS headers and answers a
  preflight (`OPTIONS`) with `401`, so a web page cannot call it, whatever
  `KEPT_MCP_ALLOWED_ORIGINS` says. That variable only lists browser origins that pass the `Origin`
  check; it does not make a browser tool (such as the MCP inspector's web UI) work. Use a local
  client, or the inspector's proxy mode.
- **Least privilege.** Give a token the read permissions it needs and no write permission by default.
  Restrict it to the accounts and categories the task is about. One token per client, with an expiry.
- **A model can be tricked.** Payment descriptions, counterparty names, notes and bill messages are
  text from third parties, and an assistant that reads them may follow instructions hidden in them.
  That is why write permissions are separate, why the write tools can only change what they say
  (never amounts, never delete payments), and why everything is revertible. Give `bills:write`,
  `matches:write`, `transactions:write` and `categories:write` deliberately, and look at the change
  log after a session.
- **Privacy.** Tool results go to your AI provider. Restrict the token if some accounts or
  categories should never leave your server.
- **Limits.** 300 requests per minute per token or connection (`429` with `Retry-After`), request bodies up to
  256 KiB, repeated rejected tokens from one address are answered with `429`, and responses are
  never cached. Tool arguments and results are never logged.
- Only `Authorization: Bearer` counts on `/api/mcp` (an API token or an OAuth access token).
  Cookies are ignored there, and a token is ignored everywhere else; an OAuth access token is not
  valid on the REST API or the mobile apps' API.

## Errors

Protocol problems are HTTP errors: `401` (with `WWW-Authenticate: Bearer realm="kept", resource_metadata="…"`, plus `error="invalid_token"` when a credential was refused) for a
missing, unknown, revoked or expired token, `403` for a foreign `Origin`, `413`/`415`/`406` for a
bad request, `429` over the limit. A tool that fails (not found, invalid input, a refused change)
answers with `isError: true` and a message the model can read; nothing else about the server is
revealed.
