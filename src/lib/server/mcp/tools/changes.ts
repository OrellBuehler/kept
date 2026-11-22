import { z } from "zod";
import type { ApiScope } from "$lib/api-tokens";
import {
  getChange,
  isRevertible,
  listChanges,
  revertChange,
  revertChanges,
  whyNotRevertible,
  type ChangeEntry,
  type RevertResult,
} from "$lib/server/audit";
import { notFound } from "$lib/server/ledger/errors";
import { idInput, MCP_DEFAULT_LIMIT, MCP_MAX_LIMIT } from "../format";
import { defineTool, holds, type ToolContext } from "../tool";

const MAX_REVERT_BATCH = 20;

/**
 * The scope that lets a connection read what an entry's summary names (a
 * creditor, a counterparty, a category). A connection that may change a payment
 * but not read it must not learn the counterparty from its change log.
 */
const SUMMARY_SCOPE: Record<string, ApiScope> = {
  bill: "bills:read",
  allocation: "bills:read",
  match_dismissal: "bills:read",
  transaction: "transactions:read",
  category: "categories:read",
  category_rule: "categories:read",
};

/** An entry as the model sees it: what happened, to what, when, and whether it can be undone. No values. */
function entryOut(ctx: ToolContext, e: ChangeEntry) {
  const needed = SUMMARY_SCOPE[e.entityType];
  const mayRead = needed !== undefined && holds(ctx, needed);
  return {
    id: e.id,
    at: new Date(e.at).toISOString(),
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    summary: mayRead ? e.summary : null,
    changedFields: Object.keys(e.after ?? e.before ?? {}).sort(),
    reverted: e.revertedAt !== null,
    isRevert: e.revertOfEntryId !== null,
    revertible: isRevertible(e),
    notRevertibleBecause: whyNotRevertible(e),
  };
}

/** The user's entry, but only when this connection made it: any other is "not found". */
async function ownEntry(ctx: ToolContext, id: string): Promise<ChangeEntry> {
  const entry = await getChange(ctx.userId, id);
  if (entry.actor.tokenId !== ctx.grant.credential.id) {
    throw notFound("Change");
  }
  return entry;
}

function revertOut(r: RevertResult) {
  return {
    revertedEntryId: r.reverted.id,
    entryId: r.entry.id,
    action: r.entry.action,
    warnings: r.warnings,
  };
}

export const changeTools = [
  defineTool({
    name: "list_changes",
    title: "List the changes made through this connection",
    description:
      "Lists the entries of Kept's change log that were made through this very connection (this token), newest first: id, time, action (for example bill.update, allocation.create, transaction.update), the entity type and id, a short summary (a creditor, counterparty or category name, never an amount; given only when the connection may also read that kind of data), the names of the fields that changed, and whether the entry can be reverted (and why not). Changes by the owner or other connections are not shown. Use the id with revert_change. Pages with nextCursor.",
    scopes: ["changes:read"],
    annotations: { readOnlyHint: true },
    input: {
      entityType: z
        .string()
        .max(100)
        .optional()
        .describe(
          "Only this kind of entity, e.g. bill, allocation, transaction, category.",
        ),
      entityId: z.string().min(1).max(100).optional(),
      limit: z.number().int().min(1).max(MCP_MAX_LIMIT).optional(),
      cursor: z
        .string()
        .max(100)
        .optional()
        .describe("The nextCursor of the previous page."),
    },
    run: async (ctx, args) => {
      const page = await listChanges(ctx.userId, {
        tokenId: ctx.grant.credential.id,
        entityType: args.entityType,
        entityId: args.entityId,
        before: args.cursor,
        limit: args.limit ?? MCP_DEFAULT_LIMIT,
      });
      return {
        items: page.items.map((e) => entryOut(ctx, e)),
        nextCursor: page.nextCursor,
      };
    },
  }),

  defineTool({
    name: "revert_change",
    title: "Revert a change made through this connection",
    description:
      "Undoes one entry of Kept's change log that this connection made (id from list_changes): a created bill is deleted, a deleted one is restored, an update gets its old values back. Refused when the data was changed afterwards in a way that undoing would lose, or the change cannot be reverted; the reason is returned. Only this connection's own changes can be reverted here; the owner can revert anything in Kept's change log. The revert is itself logged.",
    scopes: ["changes:revert"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    input: { changeId: idInput("change log entry") },
    run: async (ctx, { changeId }) => {
      await ownEntry(ctx, changeId);
      return revertOut(await revertChange(ctx.userId, changeId));
    },
  }),

  defineTool({
    name: "revert_changes",
    title: "Revert several changes made through this connection",
    description: `Undoes up to ${MAX_REVERT_BATCH} of this connection's own entries in Kept's change log, newest first so that a change made on top of another is undone before it. Stops at the first one that is refused and reports it; the ones before it stay reverted. Entries already reverted are skipped.`,
    scopes: ["changes:revert"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    input: {
      changeIds: z
        .array(idInput("change log entry"))
        .min(1)
        .max(MAX_REVERT_BATCH),
    },
    run: async (ctx, { changeIds }) => {
      for (const id of changeIds) await ownEntry(ctx, id);
      const result = await revertChanges(ctx.userId, changeIds);
      return {
        reverted: result.results.map(revertOut),
        stoppedAt: result.stoppedAt
          ? {
              changeId: result.stoppedAt.entryId,
              reason: result.stoppedAt.error.message,
            }
          : null,
      };
    },
  }),
];
