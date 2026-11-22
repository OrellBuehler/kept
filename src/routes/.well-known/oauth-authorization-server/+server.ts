import type { RequestHandler } from "./$types";
import { metadataJson, preflight } from "$lib/server/oauth/http";
import { authorizationServerMetadata } from "$lib/server/oauth/urls";

/** RFC 8414 metadata of the authorization server (the issuer has no path). */
export const GET: RequestHandler = ({ url }) =>
  metadataJson(authorizationServerMetadata(url));
export const OPTIONS: RequestHandler = () => preflight();
