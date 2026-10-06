import { apiEndpoint, parseQuery } from "$lib/server/external-api/http";
import {
  listTransactionDtos,
  transactionsQuery,
} from "$lib/server/external-api/transactions";
import { publicOrigin } from "$lib/server/external-api/urls";

export const GET = apiEndpoint("transactions:read", ({ userId, token, url }) =>
  listTransactionDtos(
    userId,
    token.categoryIds,
    parseQuery(url, transactionsQuery),
    publicOrigin(url),
  ),
);
