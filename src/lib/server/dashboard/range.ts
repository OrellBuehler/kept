import { addMonths, type NetWorthStep } from "./dates";

export const DASHBOARD_RANGES = ["3m", "6m", "12m", "all"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export function parseRange(value: string | null | undefined): DashboardRange {
  return (DASHBOARD_RANGES as readonly string[]).includes(value ?? "")
    ? (value as DashboardRange)
    : "12m";
}

/** `all` never reaches further back than this, whatever dates the data holds. */
export const MAX_ALL_YEARS = 50;

const MONTHS = { "3m": 3, "6m": 6, "12m": 12 } as const;

/** 3m and 6m use weekly points, 12m and all monthly ones. `earliest` is only used by "all". */
export function rangeWindow(
  range: DashboardRange,
  today: string,
  earliest: string | null,
): { from: string; to: string; step: NetWorthStep } {
  if (range === "all") {
    const limit = addMonths(today, -MAX_ALL_YEARS * 12);
    const start = earliest !== null && earliest < limit ? limit : earliest;
    return {
      from: start !== null && start < today ? start : today,
      to: today,
      step: "month",
    };
  }
  return {
    from: addMonths(today, -MONTHS[range]),
    to: today,
    step: range === "12m" ? "month" : "week",
  };
}
