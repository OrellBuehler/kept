import { error, fail } from "@sveltejs/kit";
import { z } from "zod";
import {
  CHANGE_ACTIONS,
  isRevertible,
  listChangeActors,
  listChanges,
  resolveReferences,
  revertChange,
  revertChanges,
  RevertError,
  whyNotRevertible,
  type ChangeFilters,
} from "$lib/server/audit";
import { requireUser } from "$lib/server/auth/guards";
import { ACTOR_KINDS } from "$lib/server/db";
import { parseForm } from "$lib/server/forms";
import { idFormSchema } from "$lib/server/ledger/schemas";
import type { Actions, PageServerLoad } from "./$types";

const PAGE_SIZE = 30;
/** Most entries one "revert all" tries; a connection with more is reverted in several rounds. */
const REVERT_ALL_LIMIT = 500;
/** Entries one "revert all" reads at most while looking for revertible ones. */
const REVERT_ALL_SCAN_LIMIT = 5_000;
const MAX_SELECTED = 200;

const ENTITY_TYPES = [
  ...new Set(Object.keys(CHANGE_ACTIONS).map((a) => a.split(".")[0]!)),
] as [string, ...string[]];

const idParam = z.string().min(1).max(100);

const querySchema = z.object({
  actor: z.enum(ACTOR_KINDS).optional(),
  token: idParam.optional(),
  type: z.enum(ENTITY_TYPES).optional(),
  entity: idParam.optional(),
  before: z
    .string()
    .regex(/^\d{1,16}:[0-9A-Za-z-]{1,64}$/)
    .optional(),
});

/** An empty parameter (`?actor=`, what a form submits for "All") counts as absent. */
function queryOf(url: URL) {
  const raw: Record<string, string> = {};
  for (const key of ["actor", "token", "type", "entity", "before"]) {
    const v = url.searchParams.get(key);
    if (v) raw[key] = v;
  }
  return querySchema.safeParse(raw);
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const user = requireUser(locals);
  const query = queryOf(url);
  if (!query.success) error(400, "That filter is not valid.");
  const q = query.data;
  const filters: ChangeFilters = {
    actorKind: q.actor,
    tokenId: q.token,
    entityType: q.type,
    entityId: q.entity,
    before: q.before,
    limit: PAGE_SIZE,
  };
  const [page, actors] = await Promise.all([
    listChanges(user.id, filters),
    listChangeActors(user.id),
  ]);
  const refs = await resolveReferences(user.id, page.items);
  return {
    filters: {
      actor: q.actor ?? null,
      token: q.token ?? null,
      type: q.type ?? null,
      entity: q.entity ?? null,
    },
    isFirstPage: q.before === undefined,
    items: page.items.map((entry) => ({
      ...entry,
      /** Why the entry cannot be reverted, or null when it can be tried. */
      blocked: whyNotRevertible(entry),
    })),
    nextCursor: page.nextCursor,
    refs,
    actors,
    entityTypes: ENTITY_TYPES,
    revertAllLimit: REVERT_ALL_LIMIT,
  };
};

function revertFailure(err: RevertError, entryId?: string) {
  return fail(err.reason === "conflict" ? 409 : 400, {
    errors: { form: [err.message] },
    reason: err.reason,
    entryId: entryId ?? null,
  });
}

const selectedSchema = z.object({
  entryId: z.array(idParam).min(1).max(MAX_SELECTED),
});

const tokenSchema = idFormSchema("tokenId");

function bulkOutcome(
  batch: Awaited<ReturnType<typeof revertChanges>>,
  capped = false,
) {
  const stopped = batch.stoppedAt;
  const warnings = batch.results.flatMap((r) => r.warnings);
  if (batch.results.length === 0 && stopped) {
    return revertFailure(stopped.error, stopped.entryId);
  }
  return {
    reverted: batch.results.length,
    warnings,
    capped,
    stoppedAt: stopped
      ? { entryId: stopped.entryId, message: stopped.error.message }
      : null,
  };
}

export const actions: Actions = {
  revert: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(idFormSchema("entryId"), await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    try {
      const result = await revertChange(user.id, parsed.data.entryId);
      return {
        reverted: 1,
        warnings: result.warnings,
        capped: false,
        stoppedAt: null,
      };
    } catch (err) {
      if (err instanceof RevertError) {
        return revertFailure(err, parsed.data.entryId);
      }
      throw err;
    }
  },

  revertSelected: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const parsed = selectedSchema.safeParse({
      entryId: form.getAll("entryId").filter((v) => typeof v === "string"),
    });
    if (!parsed.success) {
      return fail(400, {
        errors: {
          form: [`Choose between 1 and ${MAX_SELECTED} changes to revert.`],
        },
      });
    }
    return bulkOutcome(await revertChanges(user.id, parsed.data.entryId));
  },

  revertAll: async ({ locals, request }) => {
    const user = requireUser(locals);
    const parsed = parseForm(tokenSchema, await request.formData());
    if (!parsed.ok) return fail(400, { errors: parsed.errors });
    const ids: string[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    while (ids.length < REVERT_ALL_LIMIT && scanned < REVERT_ALL_SCAN_LIMIT) {
      const page = await listChanges(user.id, {
        tokenId: parsed.data.tokenId,
        before: cursor,
        limit: 200,
      });
      scanned += page.items.length;
      for (const entry of page.items) {
        if (isRevertible(entry) && ids.length < REVERT_ALL_LIMIT) {
          ids.push(entry.id);
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    if (ids.length === 0) {
      return fail(400, {
        errors: { form: ["This connection has no changes left to revert."] },
      });
    }
    return bulkOutcome(
      await revertChanges(user.id, ids),
      ids.length >= REVERT_ALL_LIMIT,
    );
  },
};
