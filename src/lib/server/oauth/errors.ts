/**
 * An error answer of an OAuth endpoint (RFC 6749 section 5.2, RFC 7591
 * section 3.2.2, RFC 7009): `{ error, error_description }` with an HTTP status.
 * Descriptions are fixed texts, never an echo of the request or of a database
 * error.
 */
export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: number = 400,
    readonly headers: Record<string, string> = {},
  ) {
    super(description);
  }
}

export function oauthErrorResponse(err: OAuthError): Response {
  return Response.json(
    { error: err.error, error_description: err.description },
    {
      status: err.status,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
        ...err.headers,
      },
    },
  );
}
