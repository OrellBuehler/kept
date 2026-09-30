import { errorCode } from "$lib/server/integrations/paperless/client";
import {
  SECRET_HEADER,
  handleWebhook,
} from "$lib/server/integrations/paperless/webhook";
import type { RequestHandler } from "./$types";

/**
 * Paperless workflow webhook. Public path (no session): the URL token selects the
 * connection and the X-Kept-Secret header authenticates the call. Answers 202 at
 * once; the document is synced in the background.
 */
export const POST: RequestHandler = async ({ params, request }) => {
  const outcome = await handleWebhook({
    token: params.token,
    secret: request.headers.get(SECRET_HEADER),
    readBody: () => request.json(),
  });
  if (outcome.status === 202) {
    outcome.done.catch((err) =>
      console.error("paperless webhook job failed", errorCode(err)),
    );
  }
  return new Response(null, { status: outcome.status });
};
