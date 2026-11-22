import type { RequestHandler } from "./$types";
import { handleRevoke } from "$lib/server/oauth/endpoints";
import { preflight } from "$lib/server/oauth/http";

/** Token revocation (RFC 7009): ends the connection the token belongs to. */
export const POST: RequestHandler = (event) => handleRevoke(event);
export const OPTIONS: RequestHandler = () => preflight();
