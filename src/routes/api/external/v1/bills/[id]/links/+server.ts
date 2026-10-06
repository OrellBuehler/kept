import { apiEndpoint, readBody } from "$lib/server/external-api/http";
import {
  assertLinkable,
  createLink,
  createLinkBody,
  listLinks,
} from "$lib/server/external-api/links";

export const GET = apiEndpoint(
  "bills:read",
  async ({ event, userId, token }) => {
    const id = event.params.id ?? "";
    await assertLinkable(userId, "bill", id, token.categoryIds);
    return { items: await listLinks(userId, "bill", id) };
  },
);

export const POST = apiEndpoint(
  "links:write",
  async ({ event, userId, token }) => {
    const id = event.params.id ?? "";
    const body = await readBody(event.request, createLinkBody);
    await assertLinkable(userId, "bill", id, token.categoryIds);
    const { link, created } = await createLink(userId, "bill", id, body);
    return Response.json(link, { status: created ? 201 : 200 });
  },
);
