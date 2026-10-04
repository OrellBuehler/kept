import { requireUser } from "$lib/server/auth/guards";
import { orNotFoundAsync } from "$lib/server/ledger/http";
import { readInstitutionLogo } from "$lib/server/ledger/logos";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params, request }) => {
  const user = requireUser(locals);
  const logo = await orNotFoundAsync(() =>
    readInstitutionLogo(user.id, params.id),
  );
  const etag = `"${logo.version}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Referrer-Policy": "no-referrer",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(logo.bytes as BodyInit, {
    headers: {
      ...headers,
      "Content-Type": logo.mime,
      "Content-Length": String(logo.bytes.byteLength),
    },
  });
};
