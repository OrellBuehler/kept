import { listBillDtos, billsQuery } from "$lib/server/external-api/bills";
import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";
import { publicOrigin } from "$lib/server/external-api/urls";

export const GET = apiEndpoint("bills:read", ({ userId, url }) =>
  listBillDtos(userId, parseQuery(url, billsQuery), publicOrigin(url)),
);
