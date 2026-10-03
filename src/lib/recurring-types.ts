export const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];

export const SERIES_STATUSES = ["suggested", "confirmed", "dismissed"] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

/** Occurrences per year; also the factor from one payment to its annual cost. */
export const CADENCE_PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};
