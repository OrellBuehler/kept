import { apiEndpoint, notFoundError } from "$lib/server/external-api/http";

/** Every other path under the prefix: a JSON 404 instead of the HTML error page. */
export const fallback = apiEndpoint(null, () => {
  throw notFoundError("Endpoint");
});
