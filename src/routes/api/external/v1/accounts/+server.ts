import { listAccountDtos, listQuery } from "$lib/server/external-api/catalog";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";

export const GET = apiEndpoint("accounts:read", ({ userId, grant, url }) =>
  listAccountDtos(userId, grant, parseQuery(url, listQuery)),
);
