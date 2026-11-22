import type { RequestHandler } from "./$types";
import { metadataJson, preflight } from "$lib/server/oauth/http";
import { protectedResourceMetadata } from "$lib/server/oauth/urls";

/** RFC 9728 metadata of `/api/mcp`, at the path-suffixed well-known URI the 401 challenge points to. */
export const GET: RequestHandler = ({ url }) =>
  metadataJson(protectedResourceMetadata(url));
export const OPTIONS: RequestHandler = () => preflight();
