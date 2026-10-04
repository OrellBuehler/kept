import { fail } from "@sveltejs/kit";
import { requireUser } from "$lib/server/auth/guards";
import { parseForm, safeValues } from "$lib/server/forms";
import { listAccounts } from "$lib/server/ledger/accounts";
import { localToday } from "$lib/server/ledger";
import { ledgerFailure } from "$lib/server/ledger/http";
import { idFormSchema } from "$lib/server/ledger/schemas";
import {
  addManualContribution,
  contributionDetailsSchema,
  deleteContribution,
  listContributions,
  manualContributionSchema,
  pillar3aOverview,
  setYearSetting,
  updateDetectedContribution,
  updateManualContribution,
  yearSettingSchema,
} from "$lib/server/pillar3a";
import type { Actions, PageServerLoad } from "./$types";

const detailFields = ["date", "kind", "gapYears", "note"] as const;
const manualFields = [...detailFields, "portfolioId", "amount"] as const;

export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals);
  const today = localToday();
  return {
    today,
    overview: pillar3aOverview(user.id, today),
    contributions: listContributions(user.id),
    accounts: listAccounts(user.id, today)
      .filter((a) => a.type === "pillar_3a")
      .map((a) => ({ id: a.id, name: a.name, archived: a.archived })),
  };
};

export const actions: Actions = {
  setYear: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["year", "deduction", "earnedIncome"]);
    const parsed = parseForm(yearSettingSchema, form);
    if (!parsed.ok) {
      return fail(400, { action: "setYear", errors: parsed.errors, values });
    }
    try {
      setYearSetting(user.id, parsed.data);
      return {
        success: true as const,
        action: "setYear" as const,
        year: parsed.data.year,
      };
    } catch (err) {
      return ledgerFailure("setYear", err, values);
    }
  },

  addContribution: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, manualFields);
    const parsed = parseForm(manualContributionSchema, form);
    if (!parsed.ok) {
      return fail(400, {
        action: "addContribution",
        errors: parsed.errors,
        values,
      });
    }
    try {
      const saved = addManualContribution(user.id, parsed.data, localToday());
      return {
        success: true as const,
        action: "addContribution" as const,
        warnings: saved.warnings,
      };
    } catch (err) {
      return ledgerFailure("addContribution", err, values);
    }
  },

  updateContribution: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, [
      "contributionId",
      "transactionId",
      ...manualFields,
    ]);
    const isDetected = form.has("transactionId");
    const idParsed = parseForm(
      idFormSchema(isDetected ? "transactionId" : "contributionId"),
      form,
    );
    if (!idParsed.ok) {
      return fail(400, {
        action: "updateContribution",
        errors: idParsed.errors,
        values,
      });
    }
    try {
      if (isDetected) {
        const parsed = parseForm(contributionDetailsSchema, form);
        if (!parsed.ok) {
          return fail(400, {
            action: "updateContribution",
            errors: parsed.errors,
            values,
          });
        }
        const saved = updateDetectedContribution(
          user.id,
          (idParsed.data as { transactionId: string }).transactionId,
          parsed.data,
          localToday(),
        );
        return {
          success: true as const,
          action: "updateContribution" as const,
          warnings: saved.warnings,
        };
      }
      const parsed = parseForm(manualContributionSchema, form);
      if (!parsed.ok) {
        return fail(400, {
          action: "updateContribution",
          errors: parsed.errors,
          values,
        });
      }
      const saved = updateManualContribution(
        user.id,
        (idParsed.data as { contributionId: string }).contributionId,
        parsed.data,
        localToday(),
      );
      return {
        success: true as const,
        action: "updateContribution" as const,
        warnings: saved.warnings,
      };
    } catch (err) {
      return ledgerFailure("updateContribution", err, values);
    }
  },

  deleteContribution: async ({ locals, request }) => {
    const user = requireUser(locals);
    const form = await request.formData();
    const values = safeValues(form, ["contributionId", "transactionId"]);
    const isDetected = form.has("transactionId");
    const parsed = parseForm(
      idFormSchema(isDetected ? "transactionId" : "contributionId"),
      form,
    );
    if (!parsed.ok) {
      return fail(400, {
        action: "deleteContribution",
        errors: parsed.errors,
        values,
      });
    }
    try {
      deleteContribution(
        user.id,
        isDetected
          ? {
              transactionId: (parsed.data as { transactionId: string })
                .transactionId,
            }
          : { id: (parsed.data as { contributionId: string }).contributionId },
      );
      return {
        success: true as const,
        action: "deleteContribution" as const,
      };
    } catch (err) {
      return ledgerFailure("deleteContribution", err, values);
    }
  },
};
