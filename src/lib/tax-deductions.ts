export const DEDUCTION_TYPES = [
  "pillar_3a",
  "donations",
  "medical",
  "childcare",
  "commuting",
  "education",
  "debt_interest",
  "alimony",
  "other",
] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

export const DEDUCTION_LABELS: Record<DeductionType, string> = {
  pillar_3a: "Pillar 3a contributions",
  donations: "Donations",
  medical: "Medical and health costs",
  childcare: "Childcare",
  commuting: "Commuting",
  education: "Further education",
  debt_interest: "Debt interest",
  alimony: "Alimony",
  other: "Other deductions",
};
