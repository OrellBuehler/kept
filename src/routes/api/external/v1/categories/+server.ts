import { listCategoryDtos, listQuery } from "$lib/server/external-api/catalog";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";

export const GET = apiEndpoint("categories:read", ({ userId, token, url }) =>
  listCategoryDtos(userId, token.categoryIds, parseQuery(url, listQuery)),
);
