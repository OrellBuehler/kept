import { listCategoryDtos, listQuery } from "$lib/server/external-api/catalog";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";

export const GET = apiEndpoint("categories:read", ({ userId, grant, url }) =>
  listCategoryDtos(userId, grant, parseQuery(url, listQuery)),
);
