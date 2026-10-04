import { error } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { getBill } from "$lib/server/bills/bills";
import { readDocument } from "$lib/server/bills/documents";
import { orNotFound, orNotFoundAsync } from "$lib/server/ledger/http";
import type { RequestHandler } from "./$types";

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const user = requireUser(locals);
  const bill = orNotFound(() => getBill(user.id, params.id));
  if (!bill.documentId) error(404, "This bill has no document.");
  const { meta, bytes } = await orNotFoundAsync(() =>
    readDocument(user.id, bill.documentId!),
  );
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeRfc5987(meta.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; object-src 'none'; frame-ancestors 'self'",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
};
