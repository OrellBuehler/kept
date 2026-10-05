import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { accounts, csvProfiles, first, getDB } from "$lib/server/db";
import {
  parseMappingProfile,
  type CsvMappingProfile,
} from "$lib/server/importers/mapping";
import { LedgerError, notFound } from "$lib/server/ledger/errors";
import { getAccount } from "$lib/server/ledger/accounts";

export interface SavedCsvProfile {
  name: string;
  profile: CsvMappingProfile;
  updatedAt: number;
}

/** Field-level messages of a mapping profile validation failure (never the submitted values). */
export function profileIssues(err: ZodError): string[] {
  return err.issues.map((i) =>
    i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
  );
}

/** The account's saved mapping profile, or null when there is none (or it no longer validates). */
export async function getCsvProfile(
  userId: string,
  accountId: string,
): Promise<SavedCsvProfile | null> {
  await getAccount(userId, accountId);
  const row = await first(
    getDB()
      .select()
      .from(csvProfiles)
      .where(
        and(
          eq(csvProfiles.userId, userId),
          eq(csvProfiles.accountId, accountId),
        ),
      )
      .limit(1),
  );
  if (!row) return null;
  let json: unknown;
  try {
    json = JSON.parse(row.profile);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.error("csv profile %s is not valid JSON", row.id);
    return null;
  }
  const parsed = parseProfileSafe(json);
  if (!parsed.ok) {
    // The caller treats this as "no profile": the user is sent to the mapping page.
    console.error("csv profile %s no longer validates", row.id);
    return null;
  }
  return {
    name: row.name,
    profile: parsed.profile,
    updatedAt: row.updatedAt.getTime(),
  };
}

export function parseProfileSafe(
  input: unknown,
): { ok: true; profile: CsvMappingProfile } | { ok: false; issues: string[] } {
  try {
    return { ok: true, profile: parseMappingProfile(input) };
  } catch (err) {
    if (err instanceof ZodError)
      return { ok: false, issues: profileIssues(err) };
    throw err;
  }
}

export async function saveCsvProfile(
  userId: string,
  accountId: string,
  name: string,
  profileJson: unknown,
): Promise<SavedCsvProfile> {
  await getAccount(userId, accountId);
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 80) {
    throw new LedgerError(
      "invalid",
      "Name must be between 1 and 80 characters.",
      "name",
    );
  }
  const parsed = parseProfileSafe(profileJson);
  if (!parsed.ok) {
    throw new LedgerError("invalid", parsed.issues.join("; "), "profile");
  }
  const serialized = JSON.stringify(parsed.profile);
  // Ownership check and upsert share one transaction; the unique index on the
  // account makes the upsert itself atomic.
  const row = getDB().transaction((tx) => {
    const owned = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, accountId)))
      .limit(1)
      .get();
    if (!owned) throw notFound("Account");
    return tx
      .insert(csvProfiles)
      .values({
        userId,
        accountId,
        name: trimmed,
        profile: serialized,
      })
      .onConflictDoUpdate({
        target: csvProfiles.accountId,
        set: { name: trimmed, profile: serialized },
      })
      .returning()
      .get();
  });
  return {
    name: row.name,
    profile: parsed.profile,
    updatedAt: row.updatedAt.getTime(),
  };
}
