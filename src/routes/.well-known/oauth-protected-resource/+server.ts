import type { RequestHandler } from "./$types";
import { metadataJson, preflight } from "$lib/server/oauth/http";
import { protectedResourceMetadata } from "$lib/server/oauth/urls";

/** RFC 9728 metadata of the MCP server, at the root form of the well-known URI. */
export const GET: RequestHandler = ({ url }) =>
  metadataJson(protectedResourceMetadata(url));
export const OPTIONS: RequestHandler = () => preflight();
