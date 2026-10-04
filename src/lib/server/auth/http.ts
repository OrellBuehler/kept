import { error } from "@sveltejs/kit";
import type { z } from "zod";

const MAX_BODY_CHARS = 50_000;

/**
 * Parses a JSON POST body with Zod. SvelteKit's CSRF protection only covers
 * form content types, so JSON endpoints check the content type and a
 * same-origin `Origin` header themselves.
 */
export async function readJsonBody<S extends z.ZodType>(
  request: Request,
  url: URL,
  schema: S,
): Promise<z.output<S>> {
  if (request.headers.get("origin") !== url.origin) {
    error(403, "Cross-origin request rejected");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    error(415, "Content-Type must be application/json");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) error(413, "Request body too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    error(400, "Body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) error(400, "Invalid request");
  return parsed.data;
}
