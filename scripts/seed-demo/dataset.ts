import type { AccountType } from "../../src/lib/ledger-types";
import {
  WALLET_OPENING,
  plain,
  addDays,
  addMonths,
  IBANS,
  PILLAR_3A_REFERENCE,
  type BillSpec,
} from "./ledger";

export interface InstitutionSpec {
  name: string;
  color: string;
  websiteUrl: string;
}

export const INSTITUTIONS: InstitutionSpec[] = [
  {
    name: "Example Bank",
    color: "#1d4ed8",
    websiteUrl: "https://example.org/bank",
  },
  {
    name: "Example Pay",
    color: "#7c3aed",
    websiteUrl: "https://example.org/pay",
  },
  {
    name: "Example Broker",
    color: "#059669",
    websiteUrl: "https://example.org/broker",
  },
];

export type AccountSpecKey =
  "checking" | "savings" | "wallet" | "broker" | "pillar3a";

export interface AccountSpec {
  key: AccountSpecKey;
  institution: string;
  name: string;
  type: AccountType;
  iban: string | null;
  depositIban?: string;
  contractNumber?: string;
  openingBalance: string;
  websiteUrl: string;
  noticeMonths?: string;
  freeWithdrawal?: string;
  freeWithdrawalPeriod?: "month" | "year";
  fillFromTransfers?: boolean;
  tradesMoveCash?: boolean;
}

export const ACCOUNTS: AccountSpec[] = [
  {
    key: "checking",
    institution: "Example Bank",
    name: "Everyday account",
    type: "current",
    iban: IBANS.checking,
    openingBalance: "18000.00",
    websiteUrl: "https://example.org/bank/login",
  },
  {
    key: "savings",
    institution: "Example Bank",
    name: "Rainy-day savings",
    type: "savings",
    iban: IBANS.savings,
    openingBalance: "21500.00",
    websiteUrl: "https://example.org/bank/login",
    noticeMonths: "3",
    freeWithdrawal: "10000.00",
    freeWithdrawalPeriod: "year",
  },
  {
    key: "wallet",
    institution: "Example Pay",
    name: "Prepaid card",
    type: "other",
    iban: IBANS.wallet,
    depositIban: IBANS.walletTopUp,
    openingBalance: plain(WALLET_OPENING),
    websiteUrl: "https://example.org/pay/login",
  },
  {
    key: "broker",
    institution: "Example Broker",
    name: "Investment account",
    type: "investment",
    iban: IBANS.broker,
    openingBalance: "3500.00",
    websiteUrl: "https://example.org/broker/login",
    fillFromTransfers: true,
    tradesMoveCash: true,
  },
  {
    key: "pillar3a",
    institution: "Example Broker",
    name: "Pillar 3a",
    type: "pillar_3a",
    iban: null,
    depositIban: IBANS.pillar3a,
    contractNumber: "P3A-1042-EX",
    openingBalance: "0.00",
    websiteUrl: "https://example.org/broker/pillar-3a",
  },
];

export interface CategorySpec {
  name: string;
  kind: "expense" | "income";
  parent?: string;
  color?: string;
  icon?: string;
}

export const CATEGORIES: CategorySpec[] = [
  { name: "Housing", kind: "expense", color: "#0ea5e9", icon: "house" },
  { name: "Rent", kind: "expense", parent: "Housing" },
  { name: "Utilities", kind: "expense", parent: "Housing" },
  {
    name: "Groceries",
    kind: "expense",
    color: "#16a34a",
    icon: "shopping-cart",
  },
  { name: "Dining", kind: "expense", color: "#f97316", icon: "utensils" },
  { name: "Transport", kind: "expense", color: "#6366f1", icon: "car" },
  { name: "Health", kind: "expense", color: "#ef4444", icon: "heart-pulse" },
  { name: "Insurance", kind: "expense", color: "#0891b2", icon: "shield" },
  { name: "Leisure", kind: "expense", color: "#a855f7", icon: "film" },
  { name: "Travel", kind: "expense", color: "#14b8a6", icon: "plane" },
  { name: "Shopping", kind: "expense", color: "#ec4899", icon: "gift" },
  { name: "Cash", kind: "expense", color: "#78716c", icon: "wallet" },
  { name: "Taxes", kind: "expense", color: "#64748b", icon: "receipt" },
  { name: "Salary", kind: "income", color: "#22c55e", icon: "wallet" },
  { name: "Interest", kind: "income", color: "#84cc16" },
];

export interface RuleSpec {
  category: string;
  counterpartyContains?: string;
  descriptionContains?: string;
  amountSign?: "income" | "expense";
}

export const RULES: RuleSpec[] = [
  { category: "Salary", counterpartyContains: "Example Employer" },
  { category: "Rent", counterpartyContains: "Example Property" },
  { category: "Utilities", counterpartyContains: "Example Energy" },
  { category: "Utilities", counterpartyContains: "Example Broadband" },
  { category: "Utilities", counterpartyContains: "Example Telecom" },
  { category: "Groceries", counterpartyContains: "Example Market" },
  { category: "Groceries", counterpartyContains: "Example Bakery" },
  { category: "Dining", counterpartyContains: "Example Cafe" },
  { category: "Dining", counterpartyContains: "Example Restaurant" },
  { category: "Transport", counterpartyContains: "Example Rail" },
  { category: "Transport", counterpartyContains: "Example Taxi" },
  { category: "Transport", counterpartyContains: "Example Garage" },
  { category: "Health", counterpartyContains: "Example Pharmacy" },
  { category: "Health", counterpartyContains: "Example Dental" },
  { category: "Insurance", counterpartyContains: "Example Health Insurance" },
  { category: "Insurance", counterpartyContains: "Example Insurance" },
  { category: "Leisure", counterpartyContains: "Example Streaming" },
  { category: "Leisure", counterpartyContains: "Example Fitness" },
  { category: "Leisure", counterpartyContains: "Example Cloud" },
  { category: "Leisure", counterpartyContains: "Example Mountain" },
  { category: "Travel", counterpartyContains: "Example Airline" },
  { category: "Travel", counterpartyContains: "Example Hotel" },
  { category: "Shopping", counterpartyContains: "Example Online Shop" },
  { category: "Cash", counterpartyContains: "Cash withdrawal" },
  { category: "Taxes", counterpartyContains: "Example Cantonal Tax" },
  {
    category: "Interest",
    descriptionContains: "Interest",
    amountSign: "income",
  },
];

export const BUDGETS: { category: string; amount: string }[] = [
  { category: "Groceries", amount: "900.00" },
  { category: "Dining", amount: "400.00" },
  { category: "Transport", amount: "900.00" },
  { category: "Health", amount: "250.00" },
  { category: "Leisure", amount: "250.00" },
  { category: "Shopping", amount: "250.00" },
];

export interface PlannedSpec {
  label: string;
  date: string;
  direction: "income" | "expense";
  amount: string;
}

/** Expected movements in the next months; the dates move with the month `today` is in. */
export function plannedItems(today: string): PlannedSpec[] {
  const next = addMonths(today.slice(0, 7), 1);
  const after = addMonths(today.slice(0, 7), 2);
  return [
    {
      label: "Holiday deposit",
      date: `${next}-03`,
      direction: "expense",
      amount: "800.00",
    },
    {
      label: "Car insurance renewal",
      date: `${next}-15`,
      direction: "expense",
      amount: "640.00",
    },
    {
      label: "Expected tax refund",
      date: `${after}-20`,
      direction: "income",
      amount: "420.00",
    },
  ];
}

export const FORECAST_SETTINGS = { threshold: "1000.00" };

export interface TaxYearSpec {
  year: number;
  authority: string;
  assessedTotal: string;
  notes: string;
}

export const TAX_YEARS: TaxYearSpec[] = [
  {
    year: 2025,
    authority: "Example Cantonal Tax Office",
    assessedTotal: "",
    notes: "Final invoice, paid in 2026.",
  },
  {
    year: 2026,
    authority: "Example Cantonal Tax Office",
    assessedTotal: "8600.00",
    notes: "Four provisional invoices; the final assessment follows next year.",
  },
];

export interface TaxCreditSpec {
  year: number;
  bookingDate: string;
  amount: string;
  reference: string;
  description: string;
}

/** What the tax office counted: one credit per paid tax invoice. */
export function taxCredits(bills: readonly BillSpec[]): TaxCreditSpec[] {
  return bills.flatMap((b) =>
    b.taxYear !== null && b.payment !== null
      ? [
          {
            year: b.taxYear,
            bookingDate: addDays(b.payment.date, 1),
            amount: plain(b.payment.amount),
            reference: b.reference,
            description: `Payment received, ${b.invoiceNumber}`,
          },
        ]
      : [],
  );
}

export const PORTFOLIO = {
  name: "Growth portfolio",
  number: "PF-1042",
  strategy: "Equity 60",
  depositReference: PILLAR_3A_REFERENCE,
  openedOn: "2025-02-10",
};
