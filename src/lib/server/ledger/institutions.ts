import { and, asc, count, eq } from "drizzle-orm";
import {
  accounts,
  getDB,
  institutions,
  isUniqueViolation,
  first,
  transaction,
} from "$lib/server/db";
import { LedgerError, notFound } from "./errors";
import type { InstitutionInput } from "./schemas";

export interface InstitutionView {
  id: string;
  name: string;
  bic: string | null;
  color: string | null;
  logoVersion: string | null;
  accountCount: number;
}

const columns = {
  id: institutions.id,
  name: institutions.name,
  bic: institutions.bic,
  color: institutions.color,
  logoVersion: institutions.logoVersion,
};

/**
 * Names are unique per user by the index on (user, name); a write that hits it
 * maps to the domain error, so there is no check-then-write window.
 */
function mapNameViolation(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new LedgerError(
      "conflict",
      "An institution with this name already exists.",
      "name",
    );
  }
  throw err;
}

export async function listInstitutions(
  userId: string,
): Promise<InstitutionView[]> {
  const db = getDB();
  const counts = new Map(
    (
      await db
        .select({ id: accounts.institutionId, n: count() })
        .from(accounts)
        .where(eq(accounts.userId, userId))
        .groupBy(accounts.institutionId)
    ).map((r) => [r.id, r.n]),
  );
  return (
    await db
      .select(columns)
      .from(institutions)
      .where(eq(institutions.userId, userId))
      .orderBy(asc(institutions.name))
  ).map((i) => ({ ...i, accountCount: counts.get(i.id) ?? 0 }));
}

export async function getInstitution(
  userId: string,
  id: string,
): Promise<InstitutionView> {
  const found = (await listInstitutions(userId)).find((i) => i.id === id);
  if (!found) throw notFound("Institution");
  return found;
}

export async function createInstitution(
  userId: string,
  input: InstitutionInput,
): Promise<InstitutionView> {
  try {
    const row = (
      await getDB()
        .insert(institutions)
        .values({ userId, ...input })
        .returning(columns)
    )[0]!;
    return { ...row!, accountCount: 0 };
  } catch (err) {
    mapNameViolation(err);
  }
}

export async function updateInstitution(
  userId: string,
  id: string,
  input: InstitutionInput,
): Promise<InstitutionView> {
  let updated: { id: string }[] = [];
  try {
    updated = await getDB()
      .update(institutions)
      .set(input)
      .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
      .returning({ id: institutions.id });
  } catch (err) {
    mapNameViolation(err);
  }
  if (updated.length === 0) throw notFound("Institution");
  return await getInstitution(userId, id);
}

export async function deleteInstitution(
  userId: string,
  id: string,
): Promise<void> {
  await transaction(async (tx) => {
    const found = await first(
      tx
        .select({ id: institutions.id })
        .from(institutions)
        .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
        .limit(1),
    );
    if (!found) throw notFound("Institution");
    const accountCount = (await first(
      tx
        .select({ n: count() })
        .from(accounts)
        .where(and(eq(accounts.userId, userId), eq(accounts.institutionId, id)))
        .limit(1),
    ))!.n;
    if (accountCount > 0) {
      throw new LedgerError(
        "conflict",
        "This institution still has accounts. Move or delete them first.",
      );
    }
    await tx
      .delete(institutions)
      .where(and(eq(institutions.userId, userId), eq(institutions.id, id)));
  });
}
