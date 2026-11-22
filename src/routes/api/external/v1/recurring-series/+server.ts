import {
  listRecurringDtos,
  recurringQuery,
} from "$lib/server/external-api/catalog";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";

export const GET = apiEndpoint("recurring:read", ({ userId, grant, url }) =>
  listRecurringDtos(userId, grant, parseQuery(url, recurringQuery)),
);
