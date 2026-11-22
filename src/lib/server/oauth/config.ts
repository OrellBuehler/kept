/**
 * Lifetimes and limits of the OAuth authorization server. One place, so a
 * test can read what the code enforces.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An access token; short, because it is what a leaked header is worth. */
export const ACCESS_TOKEN_TTL_MS = HOUR;
/** A refresh token, counted from its issue: a client unused for this long signs in again. */
export const REFRESH_TOKEN_TTL_MS = 30 * DAY;
/** From approval to redemption of an authorization code. Single use. */
export const CODE_TTL_MS = 2 * MINUTE;
/** How long a validated authorization request waits for the owner on the consent page. */
export const PENDING_REQUEST_TTL_MS = 15 * MINUTE;
/** Pending requests per user; the oldest are dropped, so a stuck client cannot fill the table. */
export const MAX_PENDING_REQUESTS_PER_USER = 10;
/** Active (not revoked, not expired) connections per user. */
export const MAX_ACTIVE_CONNECTIONS = 25;

/** Registered clients kept at most, in total. */
export const MAX_CLIENTS = 200;
/** Registrations per client address per hour. */
export const REGISTRATIONS_PER_HOUR = 10;
/** A client that nobody connected through is removed after this long. */
export const UNUSED_CLIENT_TTL_MS = DAY;
/** Revoked and expired connections (and their tokens) are kept this long for the settings page. */
export const DEAD_CONNECTION_RETENTION_MS = 30 * DAY;
/** Used and expired codes and old requests are kept this long (replay detection) before they are swept. */
export const AUTHORIZATION_RETENTION_MS = DAY;
/** Expired tokens are kept this long; a rotated refresh token must stay recognisable as such until it expires. */
export const EXPIRED_TOKEN_RETENTION_MS = DAY;

/** Failed token-endpoint calls (bad code, bad refresh token) per client address and window before it must back off. */
export const TOKEN_FAILURES_PER_IP = 30;

/** Largest body the registration, token and revocation endpoints read. */
export const OAUTH_MAX_BODY_BYTES = 16 * 1024;

export const CLIENT_NAME_MAX = 100;
export const REDIRECT_URI_MAX = 512;
export const MAX_REDIRECT_URIS = 5;
export const CLIENT_URI_MAX = 512;
export const STATE_MAX = 1024;
export const SCOPE_PARAM_MAX = 2048;
export const RESOURCE_PARAM_MAX = 2048;
