/** Shared (client-safe) pillar 3a enums. The database schema re-exports these. */
export const PILLAR_3A_DEDUCTIONS = ["small", "large", "none"] as const;
export type Pillar3aDeduction = (typeof PILLAR_3A_DEDUCTIONS)[number];

export const PILLAR_3A_CONTRIBUTION_KINDS = ["ordinary", "buy_in"] as const;
export type Pillar3aContributionKind =
  (typeof PILLAR_3A_CONTRIBUTION_KINDS)[number];

export const PORTFOLIO_CLOSE_REASONS = [
  "age",
  "wef",
  "self_employment",
  "emigration",
  "transfer",
  "disability",
  "death",
  "other",
] as const;
export type PortfolioCloseReason = (typeof PORTFOLIO_CLOSE_REASONS)[number];

export const PORTFOLIO_CLOSE_REASON_LABELS: Record<
  PortfolioCloseReason,
  string
> = {
  age: "Retirement (age benefit)",
  wef: "Home ownership (WEF)",
  self_employment: "Start of self-employment",
  emigration: "Emigration",
  transfer: "Transfer to another provider",
  disability: "Full disability",
  death: "Death",
  other: "Other",
};

export const PILLAR_3A_DEDUCTION_LABELS: Record<Pillar3aDeduction, string> = {
  small: "Small deduction (with a pension fund)",
  large: "Large deduction (no pension fund)",
  none: "No deduction",
};
