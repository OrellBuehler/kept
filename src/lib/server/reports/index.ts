import { z } from "zod";
import { LedgerError } from "$lib/server/ledger/errors";
import { localToday } from "$lib/server/ledger/balances";
import { billsReport, billsReportTitle } from "./bills-report";
import {
  loadAccountStatement,
  loadBillsReport,
  loadNetWorthReport,
} from "./loaders";
import { netWorthReport, netWorthReportTitle } from "./net-worth-report";
import { accountStatementReport, accountStatementTitle } from "./statement";

export * from "./bills-report";
export * from "./loaders";
export * from "./net-worth-report";
export * from "./statement";

export const REPORT_KINDS = ["statement", "bills", "net-worth"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y!, m! - 1, d!));
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Not a valid date.");

const statementParams = z.object({
  account: z.string().min(1, "Choose an account.").max(100),
  from: isoDate,
  to: isoDate,
});

export const reportKindSchema = z.enum(REPORT_KINDS);

export interface ReportParams {
  account?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface BuiltReport {
  bytes: Uint8Array;
  /** `kept-<kind>-<YYYY-MM-DD>.pdf` (date of generation). */
  fileName: string;
  /** Human-readable document title (contains the account name for statements). */
  title: string;
}

/**
 * Validates the params and renders a report. Safe to call with untrusted
 * input: bad params throw a LedgerError "invalid" (field-keyed), an account of
 * another user throws "not_found". `today` is the generation date.
 */
export async function buildReport(
  userId: string,
  kind: ReportKind,
  params: ReportParams = {},
  today: string = localToday(),
): Promise<BuiltReport> {
  const fileName = `kept-${kind}-${today}.pdf`;
  if (kind === "statement") {
    const parsed = statementParams.safeParse({
      account: params.account ?? undefined,
      from: params.from ?? undefined,
      to: params.to ?? undefined,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new LedgerError(
        "invalid",
        issue.message,
        String(issue.path[0] ?? "form"),
      );
    }
    const input = loadAccountStatement(
      userId,
      parsed.data.account,
      parsed.data.from,
      parsed.data.to,
      today,
    );
    return {
      bytes: await accountStatementReport(input),
      fileName,
      title: accountStatementTitle(input),
    };
  }
  if (kind === "bills") {
    const input = loadBillsReport(userId, today);
    return {
      bytes: await billsReport(input),
      fileName,
      title: billsReportTitle(input),
    };
  }
  const input = loadNetWorthReport(userId, today);
  return {
    bytes: await netWorthReport(input),
    fileName,
    title: netWorthReportTitle(input),
  };
}
