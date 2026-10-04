import { and, asc, eq } from "drizzle-orm";
import type { Minor } from "$lib/money";
import type { Pillar3aDeduction } from "$lib/pillar-3a-types";
import { getDB, pillar3aYears } from "$lib/server/db";
import type { Pillar3aYearSetting } from "$lib/pillar-3a";
import type { YearSettingInput } from "./schemas";

export interface YearSettingView extends Pillar3aYearSetting {
  deduction: Pillar3aDeduction;
  earnedIncome: Minor | null;
}

/** Explicitly stored settings, oldest first (see `settingFor` for the fallback). */
export function listYearSettings(userId: string): YearSettingView[] {
  return getDB()
    .select({
      year: pillar3aYears.year,
      deduction: pillar3aYears.deduction,
      earnedIncome: pillar3aYears.earnedIncome,
    })
    .from(pillar3aYears)
    .where(eq(pillar3aYears.userId, userId))
    .orderBy(asc(pillar3aYears.year))
    .all();
}

/** Sets the deduction type (and, for the large deduction, the earned income) of a year. */
export function setYearSetting(
  userId: string,
  input: YearSettingInput,
): YearSettingView {
  getDB()
    .insert(pillar3aYears)
    .values({ userId, ...input })
    .onConflictDoUpdate({
      target: [pillar3aYears.userId, pillar3aYears.year],
      set: {
        deduction: input.deduction,
        earnedIncome: input.earnedIncome,
        updatedAt: new Date(),
      },
    })
    .run();
  return getDB()
    .select({
      year: pillar3aYears.year,
      deduction: pillar3aYears.deduction,
      earnedIncome: pillar3aYears.earnedIncome,
    })
    .from(pillar3aYears)
    .where(
      and(eq(pillar3aYears.userId, userId), eq(pillar3aYears.year, input.year)),
    )
    .get()!;
}
