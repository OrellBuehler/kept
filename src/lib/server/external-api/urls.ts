/**
 * The public URL of this Kept instance: `ORIGIN` when set and valid (behind a
 * proxy the request URL may be an internal one), else the request's own origin.
 */
export function publicOrigin(
  requestUrl: URL,
  originEnv: string | undefined = process.env.ORIGIN,
): string {
  const configured = originEnv?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.origin;
      }
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
  }
  return requestUrl.origin;
}

export const billUrl = (origin: string, id: string) =>
  `${origin}/bills/${encodeURIComponent(id)}`;

/** Transactions have no page of their own: the account page opens one in its detail sheet. */
export const transactionUrl = (origin: string, accountId: string, id: string) =>
  `${origin}/accounts/${encodeURIComponent(accountId)}?tx=${encodeURIComponent(id)}`;
