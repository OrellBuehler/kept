import type { RequestHandler } from "./$types";
import { handleRegister } from "$lib/server/oauth/endpoints";
import { preflight } from "$lib/server/oauth/http";

/** Dynamic client registration (RFC 7591): open, bounded, public clients only. */
export const POST: RequestHandler = (event) => handleRegister(event);
export const OPTIONS: RequestHandler = () => preflight();
