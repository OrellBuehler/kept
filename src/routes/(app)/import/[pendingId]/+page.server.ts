import { redirect } from "@sveltejs/kit";
import { z } from "zod";
import { requireUser } from "$lib/server/auth/guards";
import {
  buildPreview,
  confirmImport,
  deletePending,
  MAPPING_REQUIRED,
} from "$lib/server/imports";
import { autoMatchQuietly } from "$lib/server/bills/auto-match";
import { ledgerFailure, orNotFound } from "$lib/server/ledger/http";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 100;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  filter: z.enum(["all", "new", "duplicate"]).catch("all"),
});

export const load: PageServerLoad = ({ locals, params, url }) => {
  const user = requireUser(locals);
  const preview = orNotFound(() => buildPreview(user.id, params.pendingId));
  const query = querySchema.parse({
    page: url.searchParams.get("page") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
  });
  const filtered = preview.rows.filter(
    (r) =>
      query.filter === "all" ||
      (query.filter === "new" ? r.status === "new" : r.status !== "new"),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(query.page, pageCount);
  return {
    ...preview,
    rows: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    filter: query.filter,
    page,
    pageSize: PAGE_SIZE,
    pageCount,
    filteredTotal: filtered.length,
    needsMapping: preview.errors.includes(MAPPING_REQUIRED),
    canConfirm: preview.errors.length === 0,
  };
};

export const actions: Actions = {
  confirm: ({ locals, params }) => {
    const user = requireUser(locals);
    let target: string;
    try {
      const done = confirmImport(user.id, params.pendingId);
      target = `/accounts/${done.accountId}?imported=${done.importId}`;
    } catch (err) {
      return ledgerFailure("confirm", err);
    }
    autoMatchQuietly(user.id);
    redirect(303, target);
  },

  cancel: ({ locals, params }) => {
    const user = requireUser(locals);
    try {
      deletePending(user.id, params.pendingId);
    } catch (err) {
      return ledgerFailure("cancel", err);
    }
    redirect(303, "/import");
  },
};
