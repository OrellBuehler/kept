import { isCrossOriginPath } from "$lib/server/auth/routing";

/**
 * The origin check of form posts, as SvelteKit does it, with one exception.
 *
 * SvelteKit refuses a `POST`, `PUT`, `PATCH` or `DELETE` whose body is a form
 * type (or that has no content type) unless its `Origin` header is the
 * app's own. A command-line OAuth client posts its form-encoded token request
 * with no `Origin` at all, so with the built-in check on, no such client could
 * ever get a token. The built-in check is therefore switched off
 * (`csrf.trustedOrigins: ["*"]` in `vite.config.ts`) and this function is the
 * check, applied by the `handle` hook to every request: the same rule, minus
 * the OAuth client endpoints (registration, token, revocation), which read no
 * cookie and are protected by what the client must present instead (the
 * single-use code with its PKCE verifier, a refresh token).
 *
 * Mirrors `is_csrf_forbidden` of `@sveltejs/kit` (runtime/server/csrf.js);
 * `csrf.test.ts` pins the behaviour.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FORM_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "application/x-sveltekit-formdata",
]);

export function isCsrfForbidden(request: Request, url: URL): boolean {
  if (!MUTATING.has(request.method)) return false;
  if (isCrossOriginPath(url.pathname)) return false;
  const header = request.headers.get("content-type");
  const type = header?.split(";", 1)[0]!.trim().toLowerCase() ?? "";
  if (type !== "" && !FORM_TYPES.has(type)) return false;
  return request.headers.get("origin") !== url.origin;
}

export function csrfRefusal(request: Request, url: URL): Response | null {
  if (!isCsrfForbidden(request, url)) return null;
  const message = `Cross-site ${request.method} form submissions are forbidden`;
  if (request.headers.get("accept") === "application/json") {
    return Response.json({ message }, { status: 403 });
  }
  return new Response(message, {
    status: 403,
    headers: { "content-type": "text/plain" },
  });
}
