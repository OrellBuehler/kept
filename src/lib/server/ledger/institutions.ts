import { and, asc, count, eq, ne } from "drizzle-orm";
import { accounts, getDB, institutions } from "$lib/server/db";
import { LedgerError, notFound } from "./errors";
import type { InstitutionInput } from "./schemas";

export interface InstitutionView {
  id: string;
  name: string;
  bic: string | null;
  color: string | null;
  accountCount: number;
}

const columns = {
  id: institutions.id,
  name: institutions.name,
  bic: institutions.bic,
  color: institutions.color,
};

function assertNameFree(userId: string, name: string, exceptId?: string) {
  const clash = getDB()
    .select({ id: institutions.id })
    .from(institutions)
    .where(
      and(
        eq(institutions.userId, userId),
        eq(institutions.name, name),
        exceptId ? ne(institutions.id, exceptId) : undefined,
      ),
    )
    .get();
  if (clash) {
    throw new LedgerError(
      "conflict",
      "An institution with this name already exists.",
      "name",
    );
  }
}

export function listInstitutions(userId: string): InstitutionView[] {
  const db = getDB();
  const counts = new Map(
    db
      .select({ id: accounts.institutionId, n: count() })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .groupBy(accounts.institutionId)
      .all()
      .map((r) => [r.id, r.n]),
  );
  return db
    .select(columns)
    .from(institutions)
    .where(eq(institutions.userId, userId))
    .orderBy(asc(institutions.name))
    .all()
    .map((i) => ({ ...i, accountCount: counts.get(i.id) ?? 0 }));
}

export function getInstitution(userId: string, id: string): InstitutionView {
  const found = listInstitutions(userId).find((i) => i.id === id);
  if (!found) throw notFound("Institution");
  return found;
}

export function createInstitution(
  userId: string,
  input: InstitutionInput,
): InstitutionView {
  assertNameFree(userId, input.name);
  const row = getDB()
    .insert(institutions)
    .values({ userId, ...input })
    .returning(columns)
    .get();
  return { ...row, accountCount: 0 };
}

export function updateInstitution(
  userId: string,
  id: string,
  input: InstitutionInput,
): InstitutionView {
  getInstitution(userId, id);
  assertNameFree(userId, input.name, id);
  getDB()
    .update(institutions)
    .set(input)
    .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
    .run();
  return getInstitution(userId, id);
}

export function deleteInstitution(userId: string, id: string): void {
  const inst = getInstitution(userId, id);
  if (inst.accountCount > 0) {
    throw new LedgerError(
      "conflict",
      "This institution still has accounts. Move or delete them first.",
    );
  }
  getDB()
    .delete(institutions)
    .where(and(eq(institutions.userId, userId), eq(institutions.id, id)))
    .run();
}
