import type { RequestHandler } from "./$types";
import { handleToken } from "$lib/server/oauth/endpoints";
import { preflight } from "$lib/server/oauth/http";

/** The token endpoint (RFC 6749): called by clients, no session, permissive CORS without credentials. */
export const POST: RequestHandler = (event) => handleToken(event);
export const OPTIONS: RequestHandler = () => preflight();
