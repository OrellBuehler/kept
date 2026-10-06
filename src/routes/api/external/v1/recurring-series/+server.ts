import {
  listRecurringDtos,
  recurringQuery,
} from "$lib/server/external-api/catalog";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";

export const GET = apiEndpoint("recurring:read", ({ userId, token, url }) =>
  listRecurringDtos(userId, token.categoryIds, parseQuery(url, recurringQuery)),
);
