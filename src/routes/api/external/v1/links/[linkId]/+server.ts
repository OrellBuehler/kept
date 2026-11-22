import { apiEndpoint } from "$lib/server/external-api/http";
import { deleteLink } from "$lib/server/external-api/links";

export const DELETE = apiEndpoint(
  "links:write",
  async ({ event, userId, grant }) => {
    await deleteLink(userId, event.params.linkId ?? "", grant);
    return new Response(null, { status: 204 });
  },
);
