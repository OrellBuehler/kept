import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import { mappingContext } from "$lib/server/imports";
import { LedgerError } from "$lib/server/ledger/errors";
import type { RequestHandler } from "./$types";

const MAX_BODY_CHARS = 100_000;
const bodySchema = z.object({ profile: z.unknown() });

/**
 * Live mapping preview. SvelteKit's CSRF protection only covers form
 * content types, so this JSON endpoint requires `content-type:
 * application/json` and a same-origin `Origin` header itself.
 */
export const POST: RequestHandler = async ({
  locals,
  params,
  request,
  url,
}) => {
  const user = requireUser(locals);
  if (request.headers.get("origin") !== url.origin) {
    error(403, "Cross-origin request rejected");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    error(415, "Content-Type must be application/json");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) error(413, "Request body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) error(413, "Request body too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    error(400, "Body is not valid JSON");
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) error(400, "Expected a JSON object with a profile");

  try {
    return json(mappingContext(user.id, params.pendingId, body.data.profile));
  } catch (err) {
    if (err instanceof LedgerError) {
      error(err.code === "not_found" ? 404 : 400, err.message);
    }
    throw err;
  }
};
