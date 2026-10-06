import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { z } from "zod";
import {
  EXTERNAL_LINK_MAX_LABEL,
  EXTERNAL_LINK_MAX_SOURCE,
  EXTERNAL_LINK_MAX_URL,
  type ExternalLinkEntityType,
} from "$lib/api-tokens";
import {
  bills,
  externalLinks,
  first,
  getDB,
  transaction,
  transactions,
} from "$lib/server/db";
import { hasControlOrSpace, normalizeLinkUrl } from "$lib/external-links";
import { ApiError, iso, notFoundError } from "./http";

/** Links one bill or transaction may carry. */
export const MAX_LINKS_PER_ENTITY = 20;

export interface ExternalLinkDto {
  id: string;
  entityType: ExternalLinkEntityType;
  entityId: string;
  /** The app that created the link. */
  source: string;
  label: string;
  url: string;
  createdAt: string;
}

const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} is required.`)
    .refine((v) => !hasControlOrSpace(v), `${what} has control characters.`)
    .pipe(z.string().max(max, `${what} must be at most ${max} characters.`));

export const createLinkBody = z.object({
  source: text(EXTERNAL_LINK_MAX_SOURCE, "Source"),
  label: text(EXTERNAL_LINK_MAX_LABEL, "Label"),
  url: z
    .string()
    .max(
      EXTERNAL_LINK_MAX_URL,
      `URL must be at most ${EXTERNAL_LINK_MAX_URL} characters.`,
    )
    .transform((v, ctx) => {
      const normalised = normalizeLinkUrl(v);
      if (normalised === null) {
        ctx.addIssue({
          code: "custom",
          message: "Use an absolute http or https URL without credentials.",
        });
        return z.NEVER;
      }
      if (normalised.length > EXTERNAL_LINK_MAX_URL) {
        ctx.addIssue({ code: "custom", message: "URL is too long." });
        return z.NEVER;
      }
      return normalised;
    }),
});
export type CreateLinkBody = z.output<typeof createLinkBody>;

type Row = typeof externalLinks.$inferSelect;

const toDto = (r: Row): ExternalLinkDto => ({
  id: r.id,
  entityType: r.entityType,
  entityId: r.entityId,
  source: r.source,
  label: r.label,
  url: r.url,
  createdAt: iso(r.createdAt),
});

/** Whether the user owns the entity and, for a transaction, a category-restricted token may see it. */
async function entityVisible(
  userId: string,
  entityType: ExternalLinkEntityType,
  entityId: string,
  allowedCategories: readonly string[] | null,
): Promise<boolean> {
  const db = getDB();
  if (entityType === "bill") {
    const found = await first(
      db
        .select({ id: bills.id })
        .from(bills)
        .where(and(eq(bills.userId, userId), eq(bills.id, entityId)))
        .limit(1),
    );
    return found !== undefined;
  }
  const found = await first(
    db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(
        and(eq(transactions.userId, userId), eq(transactions.id, entityId)),
      )
      .limit(1),
  );
  if (!found) return false;
  return (
    allowedCategories === null ||
    (found.categoryId !== null && allowedCategories.includes(found.categoryId))
  );
}

/** Throws "not found" for an entity the user does not own or the token may not see. */
export async function assertLinkable(
  userId: string,
  entityType: ExternalLinkEntityType,
  entityId: string,
  allowedCategories: readonly string[] | null,
): Promise<void> {
  if (!(await entityVisible(userId, entityType, entityId, allowedCategories))) {
    throw notFoundError(entityType === "bill" ? "Bill" : "Transaction");
  }
}

export async function listLinks(
  userId: string,
  entityType: ExternalLinkEntityType,
  entityId: string,
): Promise<ExternalLinkDto[]> {
  const rows = await getDB()
    .select()
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.userId, userId),
        eq(externalLinks.entityType, entityType),
        eq(externalLinks.entityId, entityId),
      ),
    )
    .orderBy(asc(externalLinks.createdAt), asc(externalLinks.id));
  return rows.map(toDto);
}

/** Links of several entities at once (for the detail screens), by entity id. */
export async function linksByEntity(
  userId: string,
  entityType: ExternalLinkEntityType,
  entityIds: readonly string[],
): Promise<Record<string, ExternalLinkDto[]>> {
  const out: Record<string, ExternalLinkDto[]> = {};
  if (entityIds.length === 0) return out;
  const rows = await getDB()
    .select()
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.userId, userId),
        eq(externalLinks.entityType, entityType),
        inArray(externalLinks.entityId, [...entityIds]),
      ),
    )
    .orderBy(asc(externalLinks.createdAt), asc(externalLinks.id));
  for (const r of rows) (out[r.entityId] ??= []).push(toDto(r));
  return out;
}

/**
 * Adds a link, or refreshes the label of the identical one (same entity,
 * source and URL): posting twice is safe. `created` tells which happened.
 */
export async function createLink(
  userId: string,
  entityType: ExternalLinkEntityType,
  entityId: string,
  body: CreateLinkBody,
): Promise<{ link: ExternalLinkDto; created: boolean }> {
  return await transaction(
    async (tx) => {
      const same = and(
        eq(externalLinks.userId, userId),
        eq(externalLinks.entityType, entityType),
        eq(externalLinks.entityId, entityId),
      );
      const existing = await first(
        tx
          .select()
          .from(externalLinks)
          .where(
            and(
              same,
              eq(externalLinks.source, body.source),
              eq(externalLinks.url, body.url),
            ),
          )
          .limit(1),
      );
      if (existing) {
        const [row] = await tx
          .update(externalLinks)
          .set({ label: body.label })
          .where(eq(externalLinks.id, existing.id))
          .returning();
        return { link: toDto(row!), created: false };
      }
      const count = (
        await tx
          .select({ id: externalLinks.id })
          .from(externalLinks)
          .where(same)
      ).length;
      if (count >= MAX_LINKS_PER_ENTITY) {
        throw new ApiError(
          409,
          `At most ${MAX_LINKS_PER_ENTITY} links per ${entityType}.`,
        );
      }
      const [row] = await tx
        .insert(externalLinks)
        .values({ userId, entityType, entityId, ...body })
        .returning();
      return { link: toDto(row!), created: true };
    },
    { lock: `external-links:${userId}` },
  );
}

/**
 * Deletes a link of this user. A transaction link that a category-restricted
 * token cannot see is "not found", like a link of another user.
 */
export async function deleteLink(
  userId: string,
  linkId: string,
  allowedCategories: readonly string[] | null,
): Promise<void> {
  const link = await first(
    getDB()
      .select()
      .from(externalLinks)
      .where(
        and(eq(externalLinks.userId, userId), eq(externalLinks.id, linkId)),
      )
      .limit(1),
  );
  if (!link) throw notFoundError("Link");
  // An orphan, or a transaction hidden from this token, is as "not found" as another user's link.
  if (
    !(await entityVisible(
      userId,
      link.entityType,
      link.entityId,
      allowedCategories,
    ))
  ) {
    throw notFoundError("Link");
  }
  await getDB()
    .delete(externalLinks)
    .where(and(eq(externalLinks.userId, userId), eq(externalLinks.id, linkId)));
}

/** Removes links whose bill or transaction no longer exists. Reads never show them; this only frees the rows. */
export async function sweepOrphanedLinks(): Promise<void> {
  const db = getDB();
  await db
    .delete(externalLinks)
    .where(
      and(
        eq(externalLinks.entityType, "bill"),
        notExists(
          db
            .select({ id: bills.id })
            .from(bills)
            .where(eq(bills.id, externalLinks.entityId)),
        ),
      ),
    );
  await db
    .delete(externalLinks)
    .where(
      and(
        eq(externalLinks.entityType, "transaction"),
        notExists(
          db
            .select({ id: transactions.id })
            .from(transactions)
            .where(eq(transactions.id, externalLinks.entityId)),
        ),
      ),
    );
}
