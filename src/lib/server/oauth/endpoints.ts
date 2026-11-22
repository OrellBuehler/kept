import type { RequestEvent } from "@sveltejs/kit";
import { getClient, parseRegistration, registerClient } from "./clients";
import { OAuthError, oauthErrorResponse } from "./errors";
import {
  acquireOrRefuse,
  oauthJson,
  readBodyText,
  readForm,
  registrationLimiter,
  revocationLimiter,
  tokenFailureLimiter,
  withCors,
} from "./http";
import {
  exchangeAuthorizationCode,
  refreshTokens,
  revocationSchema,
  revokeToken,
  tokenRequestSchema,
} from "./token";

/**
 * The request handlers of the public endpoints (registration, token,
 * revocation). The route files only delegate here. Every answer, error or not,
 * carries the CORS headers: a browser-based client must be able to read why a
 * request failed.
 */
async function answer(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof OAuthError) return withCors(oauthErrorResponse(err));
    throw err;
  }
}

/** RFC 7591: open registration of public clients; every field validated, the table bounded. */
export function handleRegister(event: RequestEvent): Promise<Response> {
  return answer(async () => {
    acquireOrRefuse(registrationLimiter, event);
    const type = event.request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      throw new OAuthError(
        "invalid_client_metadata",
        "The content type must be application/json.",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBodyText(event.request));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new OAuthError(
          "invalid_client_metadata",
          "The body is not valid JSON.",
        );
      }
      throw err;
    }
    const meta = parseRegistration(body);
    const client = await registerClient(meta);
    return oauthJson(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        ...(client.clientUri ? { client_uri: client.clientUri } : {}),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });
}

/** RFC 6749 section 3.2: the authorization code and refresh token grants. */
export function handleToken(event: RequestEvent): Promise<Response> {
  return answer(async () => {
    const attempt = acquireOrRefuse(tokenFailureLimiter, event);
    const form = await readForm(event.request);
    if (!form.grant_type) {
      throw new OAuthError("invalid_request", "The grant_type is missing.");
    }
    if (
      form.grant_type !== "authorization_code" &&
      form.grant_type !== "refresh_token"
    ) {
      throw new OAuthError(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported.",
      );
    }
    const parsed = tokenRequestSchema.safeParse(form);
    if (!parsed.success) {
      throw new OAuthError(
        "invalid_request",
        "A required parameter is missing or invalid.",
      );
    }
    const tokens =
      parsed.data.grant_type === "authorization_code"
        ? await exchangeAuthorizationCode(parsed.data, event.url)
        : await refreshTokens(parsed.data, event.url);
    attempt.release();
    return oauthJson(tokens);
  });
}

/** RFC 7009: ends the connection a token belongs to. Unknown tokens are not an error. */
export function handleRevoke(event: RequestEvent): Promise<Response> {
  return answer(async () => {
    acquireOrRefuse(revocationLimiter, event);
    const form = await readForm(event.request);
    const parsed = revocationSchema.safeParse(form);
    if (!parsed.success) {
      throw new OAuthError(
        "invalid_request",
        "The token and client_id are required.",
      );
    }
    if (await getClient(parsed.data.client_id)) {
      await revokeToken(parsed.data);
    }
    return oauthJson({});
  });
}
