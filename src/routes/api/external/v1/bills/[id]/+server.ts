import { getBillDto } from "$lib/server/external-api/bills";
import { apiEndpoint } from "$lib/server/external-api/http";
import { publicOrigin } from "$lib/server/external-api/urls";

export const GET = apiEndpoint("bills:read", ({ event, userId, url }) =>
  getBillDto(userId, event.params.id ?? "", publicOrigin(url)),
);
