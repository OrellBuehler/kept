import { apiEndpoint } from "$lib/server/external-api/http";
import { getTransactionDto } from "$lib/server/external-api/transactions";
import { publicOrigin } from "$lib/server/external-api/urls";

export const GET = apiEndpoint(
  "transactions:read",
  ({ event, userId, token, url }) =>
    getTransactionDto(
      userId,
      token.categoryIds,
      event.params.id ?? "",
      publicOrigin(url),
    ),
);
