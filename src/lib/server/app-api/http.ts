import { json } from "@sveltejs/kit";
import type { z } from "zod";

const MAX_BODY_CHARS = 10_000;

/** An error answer of the app API: JSON `{ message }` whatever the request's `Accept`. */
export function jsonMessage(
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return json({ message }, { status, headers });
}

/**
 * A small JSON body of the app API, parsed with Zod, or the error response to
 * send instead. A bearer request needs no Origin check: no cookie authenticates it.
 */
export async function readAppBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S> | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return jsonMessage("Content-Type must be application/json.", 415);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) {
    return jsonMessage("Request body too large.", 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return jsonMessage("Request body too large.", 413);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return jsonMessage("Body is not valid JSON.", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonMessage(
      parsed.error.issues[0]?.message ?? "Invalid request.",
      400,
    );
  }
  return parsed.data;
}
