import { error } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { LedgerError } from "$lib/server/ledger/errors";
import { buildReport, reportKindSchema } from "$lib/server/reports";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const user = requireUser(locals);
  const kind = reportKindSchema.safeParse(params.kind);
  if (!kind.success) error(404, "Unknown report.");
  try {
    const { bytes, fileName } = await buildReport(user.id, kind.data, {
      account: url.searchParams.get("account"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
    });
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof LedgerError) {
      error(err.code === "not_found" ? 404 : 400, err.message);
    }
    throw err;
  }
};
