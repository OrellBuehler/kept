import { and, asc, eq } from "drizzle-orm";
import type { Minor } from "$lib/money";
import type { Pillar3aDeduction } from "$lib/pillar-3a-types";
import { first, getDB, pillar3aYears, type DB } from "$lib/server/db";
import type { Pillar3aYearSetting } from "$lib/pillar-3a";
import type { YearSettingInput } from "./schemas";

export interface YearSettingView extends Pillar3aYearSetting {
  deduction: Pillar3aDeduction;
  earnedIncome: Minor | null;
}

function yearSettingsQuery(conn: Pick<DB, "select">, userId: string) {
  return conn
    .select({
      year: pillar3aYears.year,
      deduction: pillar3aYears.deduction,
      earnedIncome: pillar3aYears.earnedIncome,
    })
    .from(pillar3aYears)
    .where(eq(pillar3aYears.userId, userId))
    .orderBy(asc(pillar3aYears.year));
}

/** Explicitly stored settings, oldest first (see `settingFor` for the fallback). */
export async function listYearSettings(
  userId: string,
): Promise<YearSettingView[]> {
  return await yearSettingsQuery(getDB(), userId);
}

/** Sync twin of listYearSettings, for the body of a transaction. */
export function listYearSettingsInTx(
  tx: Pick<DB, "select">,
  userId: string,
): YearSettingView[] {
  return yearSettingsQuery(tx, userId).all();
}

/** Sets the deduction type (and, for the large deduction, the earned income) of a year. */
export async function setYearSetting(
  userId: string,
  input: YearSettingInput,
): Promise<YearSettingView> {
  await getDB()
    .insert(pillar3aYears)
    .values({ userId, ...input })
    .onConflictDoUpdate({
      target: [pillar3aYears.userId, pillar3aYears.year],
      set: {
        deduction: input.deduction,
        earnedIncome: input.earnedIncome,
        updatedAt: new Date(),
      },
    });
  return (await first(
    getDB()
      .select({
        year: pillar3aYears.year,
        deduction: pillar3aYears.deduction,
        earnedIncome: pillar3aYears.earnedIncome,
      })
      .from(pillar3aYears)
      .where(
        and(
          eq(pillar3aYears.userId, userId),
          eq(pillar3aYears.year, input.year),
        ),
      )
      .limit(1),
  ))!;
}
