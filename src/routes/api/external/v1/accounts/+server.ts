import { listAccountDtos, listQuery } from "$lib/server/external-api/catalog";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";

export const GET = apiEndpoint("accounts:read", ({ userId, url }) =>
  listAccountDtos(userId, parseQuery(url, listQuery)),
);
