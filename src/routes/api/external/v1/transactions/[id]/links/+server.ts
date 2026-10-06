import { apiEndpoint, readBody } from "$lib/server/external-api/http";
import {
  assertLinkable,
  createLink,
  createLinkBody,
  listLinks,
} from "$lib/server/external-api/links";

export const GET = apiEndpoint(
  "transactions:read",
  async ({ event, userId, token }) => {
    const id = event.params.id ?? "";
    await assertLinkable(userId, "transaction", id, token.categoryIds);
    return { items: await listLinks(userId, "transaction", id) };
  },
);

export const POST = apiEndpoint(
  "links:write",
  async ({ event, userId, token }) => {
    const id = event.params.id ?? "";
    const body = await readBody(event.request, createLinkBody);
    await assertLinkable(userId, "transaction", id, token.categoryIds);
    const { link, created } = await createLink(userId, "transaction", id, body);
    return Response.json(link, { status: created ? 201 : 200 });
  },
);
