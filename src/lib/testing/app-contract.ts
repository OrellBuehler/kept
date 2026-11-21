import { eq } from "drizzle-orm";
import type { CategoryIcon } from "$lib/category-types";
import { minor, parseAmount } from "$lib/money";
import { parseFixed } from "$lib/quantity";
import {
  createApiToken,
  revokeApiToken,
  verifyApiToken,
} from "$lib/server/auth/api-tokens";
import { recordAdminAction } from "$lib/server/auth/admin-audit";
import { allocate, allocateFromInput } from "$lib/server/bills/allocations";
import { cancelBill, createBill } from "$lib/server/bills/bills";
import { storeDocument } from "$lib/server/bills/documents";
import {
  dismissSuggestion,
  runAutoMatching,
} from "$lib/server/bills/suggestions";
import {
  applyRulesToUncategorized,
  assignCategory,
  createBudget,
  createCategory,
  createRule,
} from "$lib/server/categories";
import { getDB, users } from "$lib/server/db";
import { createLink } from "$lib/server/external-api/links";
import { createPlannedItem, saveAccountSettings } from "$lib/server/forecast";
import { confirmImport, saveCsvProfile } from "$lib/server/imports";
import { upsertFxRates } from "$lib/server/investments";
import {
  archiveAccount,
  createInstitution,
  createManualTransaction,
  createSnapshot,
  localToday,
  setInstitutionLogo,
  updateTransaction,
} from "$lib/server/ledger";
import {
  saveChannel,
  recordChannelResult,
  saveSettings,
} from "$lib/server/notifications/store";
import {
  addManualContribution,
  closePortfolio,
  setValues,
  setYearSetting,
  updateDetectedContribution,
} from "$lib/server/pillar3a";
import { updatePreferences } from "$lib/server/preferences";
import {
  listRecurring,
  syncRecurring,
  confirmSeries,
  dismissSeries,
} from "$lib/server/recurring";
import {
  addTaxCredit,
  setCategoryDeduction,
  setTransactionDeductionExcluded,
  setTransactionDeductionYear,
  setTransactionTaxYear,
  upsertTaxYear,
} from "$lib/server/tax";
import { linkTransfers } from "$lib/server/transfers";
import { seedToken } from "./external-api";
import { fixture } from "./fixtures";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
  EXAMPLE_QRR,
  EXAMPLE_SCOR,
  FOREIGN_IBANS,
} from "./fixtures/bill-identifiers";
import { billInput } from "./bills";
import {
  seedManualPrice,
  seedProviderPrice,
  seedSecurity,
  seedTrade,
} from "./investments";
import { SIMPLE_CSV_PROFILE, uploadFixture } from "./imports";
import {
  seedAccount,
  seedImportedTransaction,
  seedInstitution,
} from "./ledger";
import { makeQrr, seedPillar3aAccount, seedPortfolio } from "./pillar3a";
import { addPasskey, enableTotp } from "./auth";

/*
 * One rich, synthetic dataset for the app contract (see
 * src/routes/api/app/v1/contract.test.ts). Everything is invented: "Example"
 * names, the documented example IBANs, amounts that mean nothing. Dates are
 * relative to today so that "recent" lists are never empty.
 *
 * Rows are written by the same server functions the web app uses. Where a
 * test helper inserts a row directly (seedImportedTransaction) it writes
 * what the import flow writes.
 */

/** Marker put into every name of the second user, so a test can grep for it. */
export const OTHER_USER_MARKER = "OTHER-USER";

const pad = (n: number) => String(n).padStart(2, "0");

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** `YYYY-MM` of the month `back` months before the month of `date`. */
export function monthOf(date: string, back: number): string {
  const [y, m] = date.split("-").map(Number);
  const total = y! * 12 + (m! - 1) - back;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

export interface ContractIds {
  today: string;
  /** The year of the tax return the seed fills (last year). */
  taxYear: number;
  /** `YYYY-MM` of the last full month; budgets are captured for it. */
  budgetMonth: string;
  institutions: { bank: string; broker: string };
  accounts: {
    checking: string;
    savings: string;
    creditCard: string;
    investment: string;
    pillar3a: string;
    pension: string;
    euro: string;
    joint: string;
    wallet: string;
    archived: string;
  };
  bills: {
    open: string;
    overdue: string;
    paid: string;
    paidAuto: string;
    partial: string;
    cancelled: string;
    creditNote: string;
  };
  pending: {
    /** A statement file with new and duplicate rows. */
    statement: string;
    /** A CSV without a saved mapping. */
    csv: string;
  };
  securities: { etf: string; stock: string; bond: string };
  /** A stored bill document, for `bills/new?document=`. */
  documentId: string;
  /** A transaction of the checking account, for `accounts/[id]?tx=`. */
  focusTransactionId: string;
  rest: { token: string; revokedToken: string };
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`contract seed: ${what} is missing`);
  }
  return value;
}

const amount = (text: string) => parseAmount(text);

function assertTokenAccepted(result: { ok: boolean }): void {
  if (!result.ok) throw new Error("contract seed: the API token was refused");
}

/** Seeds `userId` with data for every page of the app API; returns the ids the capture needs. */
export async function seedContractData(userId: string): Promise<ContractIds> {
  const today = localToday();
  const thisYear = Number(today.slice(0, 4));
  const taxYear = thisYear - 1;
  const M = (back: number, day: number) =>
    `${monthOf(today, back)}-${pad(day)}`;
  /** A date this year that is not in the future. */
  const thisYearOn = (monthDay: string) => {
    const date = `${thisYear}-${monthDay}`;
    return date > today ? today : date;
  };

  const actor = must(
    (
      await getDB()
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0],
    "the user",
  );

  await updatePreferences(userId, {
    ibanDisplay: "masked",
    blurAmounts: true,
    locale: "de-CH",
    defaultCurrency: "CHF",
    pageSize: 25,
    investmentCashLiquid: true,
  });

  // --- institutions and accounts -----------------------------------------

  const bank = await createInstitution(userId, {
    name: "Example Bank",
    bic: "EXAMCHZZ",
    color: "#1a73e8",
  });
  await setInstitutionLogo(
    userId,
    bank.id,
    new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1a73e8"/></svg>',
    ),
  );
  const broker = await seedInstitution(userId, "Example Broker");

  const account = (over: Parameters<typeof seedAccount>[1]) =>
    seedAccount(userId, over);

  const checking = await account({
    name: "Example Checking",
    type: "current",
    iban: EXAMPLE_IBAN,
    institutionId: bank.id,
    openingBalance: amount("2500.00"),
    sortOrder: 0,
  });
  const savings = await account({
    name: "Example Savings",
    type: "savings",
    iban: EXAMPLE_IBAN_THIRD,
    institutionId: bank.id,
    openingBalance: amount("12000.00"),
    openingDate: addDays(today, -120),
    noticeMonths: 3,
    freeWithdrawal: amount("5000.00"),
    freeWithdrawalPeriod: "year",
    fillFromTransfers: true,
    sortOrder: 1,
  });
  const creditCard = await account({
    name: "Example Credit Card",
    type: "credit_card",
    institutionId: bank.id,
    sortOrder: 2,
  });
  const investment = await account({
    name: "Example Brokerage",
    type: "investment",
    institutionId: broker.id,
    openingBalance: amount("20000.00"),
    openingDate: addDays(today, -200),
    tradesMoveCash: true,
    sortOrder: 3,
  });
  const pillar3a = await seedPillar3aAccount(userId, {
    name: "Example Pillar 3a",
    institutionId: broker.id,
    contractNumber: "EX-3A-0001",
    sortOrder: 4,
  });
  const pension = await account({
    name: "Example Pension Fund",
    type: "pension",
    iban: FOREIGN_IBANS[3],
    openingBalance: amount("45000.00"),
    openingDate: addDays(today, -200),
    sortOrder: 5,
  });
  const euro = await account({
    name: "Example Euro Account",
    type: "current",
    currency: "EUR",
    iban: FOREIGN_IBANS[0],
    institutionId: bank.id,
    openingBalance: amount("800.00"),
    fillFromTransfers: true,
    sortOrder: 6,
  });
  const joint = await account({
    name: "Example Joint Account",
    type: "current",
    iban: FOREIGN_IBANS[4],
    institutionId: bank.id,
    openingBalance: amount("3000.00"),
    shareBps: 5000,
    sharedWith: "Alice Example",
    sortOrder: 7,
  });
  const wallet = await account({
    name: "Example Wallet",
    type: "cash",
    openingBalance: amount("100.00"),
    sortOrder: 8,
  });
  const archived = await account({
    name: "Example Old Account",
    type: "other",
    openingBalance: amount("0.00"),
    sortOrder: 9,
  });

  // --- categories, rules, budgets, deduction mappings --------------------

  const category = (
    name: string,
    kind: "income" | "expense",
    over: {
      parentId?: string | null;
      color?: string | null;
      icon?: CategoryIcon | null;
    } = {},
  ) =>
    createCategory(userId, {
      name,
      kind,
      parentId: over.parentId ?? null,
      color: over.color ?? null,
      icon: over.icon ?? null,
    });
  const salary = await category("Salary", "income", {
    color: "#2e7d32",
    icon: "wallet",
  });
  const gifts = await category("Gifts received", "income", { icon: "gift" });
  const food = await category("Food", "expense", {
    color: "#e65100",
    icon: "utensils",
  });
  const groceries = await category("Groceries", "expense", {
    parentId: food.id,
    color: "#ef6c00",
    icon: "shopping-cart",
  });
  const restaurants = await category("Restaurants", "expense", {
    parentId: food.id,
  });
  const housing = await category("Housing", "expense", {
    color: "#6a1b9a",
    icon: "house",
  });
  const transport = await category("Transport", "expense", { icon: "car" });
  const health = await category("Health", "expense", {
    color: "#c62828",
    icon: "heart-pulse",
  });
  const pharmacyCategory = await category("Pharmacy", "expense", {
    parentId: health.id,
    color: "#ad1457",
    icon: "heart-pulse",
  });
  const insurance = await category("Insurance", "expense", { icon: "shield" });
  const subscriptions = await category("Subscriptions", "expense");
  const donations = await category("Donations", "expense", { icon: "gift" });

  await createRule(userId, {
    categoryId: groceries.id,
    priority: 10,
    counterpartyContains: "Grocer",
    descriptionContains: null,
    counterpartyIban: null,
    amountSign: "expense",
  });
  await createRule(userId, {
    categoryId: restaurants.id,
    priority: 20,
    counterpartyContains: "Bistro",
    descriptionContains: null,
    counterpartyIban: null,
    amountSign: null,
  });
  await createRule(userId, {
    categoryId: housing.id,
    priority: 30,
    counterpartyContains: null,
    descriptionContains: "Rent",
    counterpartyIban: FOREIGN_IBANS[1],
    amountSign: null,
  });
  await createRule(userId, {
    categoryId: subscriptions.id,
    priority: 40,
    counterpartyContains: "Streaming",
    descriptionContains: null,
    counterpartyIban: null,
    amountSign: null,
  });
  await createRule(userId, {
    categoryId: insurance.id,
    priority: 50,
    counterpartyContains: "Insurance",
    descriptionContains: null,
    counterpartyIban: null,
    amountSign: "expense",
  });
  await createRule(userId, {
    categoryId: donations.id,
    priority: 60,
    counterpartyContains: "Charity",
    descriptionContains: null,
    counterpartyIban: null,
    amountSign: null,
  });
  await createRule(userId, {
    categoryId: salary.id,
    priority: 500,
    counterpartyContains: null,
    descriptionContains: null,
    counterpartyIban: null,
    amountSign: "income",
  });

  await createBudget(userId, {
    categoryId: groceries.id,
    currency: "CHF",
    amount: amount("400.00"),
  });
  await createBudget(userId, {
    categoryId: restaurants.id,
    currency: "CHF",
    amount: amount("100.00"),
  });
  await createBudget(userId, {
    categoryId: housing.id,
    currency: "CHF",
    amount: amount("2000.00"),
  });
  await createBudget(userId, {
    categoryId: transport.id,
    currency: "CHF",
    amount: amount("150.00"),
  });

  await setCategoryDeduction(userId, donations.id, "donations");
  await setCategoryDeduction(userId, health.id, "medical");

  // --- imports (statement files go through the real confirm flow) --------

  await confirmImport(
    userId,
    await uploadFixture(userId, checking.id, "camt053/overlap-a.xml"),
  );
  // A statement without transactions: the import keeps its warning.
  await confirmImport(
    userId,
    await uploadFixture(userId, checking.id, "camt053/empty-statement.xml"),
  );
  await saveCsvProfile(
    userId,
    creditCard.id,
    "Example export",
    SIMPLE_CSV_PROFILE,
  );
  await confirmImport(
    userId,
    await uploadFixture(userId, creditCard.id, "csv/overlap-a.csv"),
  );

  // --- transactions -------------------------------------------------------

  const tx = (
    accountId: string,
    bookingDate: string,
    value: string,
    over: Parameters<typeof seedImportedTransaction>[2] = {},
  ) =>
    seedImportedTransaction(userId, accountId, {
      bookingDate,
      amount: amount(value),
      ...over,
    });

  // Regular payments: income, rent, a subscription whose price went up.
  for (const back of [3, 2, 1]) {
    await tx(checking.id, M(back, 25), "9500.00", {
      counterpartyName: "Example Employer AG",
      counterpartyIban: FOREIGN_IBANS[5],
      description: "Salary",
      valueDate: M(back, 25),
    });
    await tx(checking.id, M(back, 10), back === 1 ? "-12.90" : "-11.90", {
      counterpartyName: "Example Streaming SA",
      description: "Monthly plan",
    });
  }
  for (const back of [3, 2, 1, 0]) {
    await tx(checking.id, M(back, 1), "-1800.00", {
      counterpartyName: "Example Property Management AG",
      counterpartyIban: FOREIGN_IBANS[1],
      description: `Rent ${monthOf(today, back)}`,
      reference: EXAMPLE_SCOR,
      referenceType: "SCOR",
    });
  }

  // Everyday spending.
  const spending: [number, number, string, string, string][] = [
    [1, 3, "-92.40", "Example Grocer", "Weekly shop"],
    [1, 9, "-61.15", "Example Grocer", "Weekly shop"],
    [1, 20, "-78.30", "Example Grocer", "Weekly shop"],
    [1, 27, "-48.20", "Example Grocer", "Weekly shop"],
    [1, 12, "-68.00", "Example Bistro", "Dinner"],
    [1, 22, "-72.50", "Example Bistro", "Dinner"],
    [2, 6, "-84.10", "Example Grocer", "Weekly shop"],
    [2, 17, "-71.60", "Example Grocer", "Weekly shop"],
    [2, 14, "-39.00", "Example Bistro", "Lunch"],
    [3, 8, "-101.25", "Example Grocer", "Weekly shop"],
    [3, 19, "-55.80", "Example Bistro", "Dinner"],
  ];
  for (const [back, day, value, name, description] of spending) {
    await tx(checking.id, M(back, day), value, {
      counterpartyName: name,
      description,
    });
  }
  const recentGrocer = await tx(checking.id, addDays(today, -1), "-34.80", {
    counterpartyName: "Example Grocer",
    description: "Weekly shop",
  });
  await tx(checking.id, addDays(today, -4), "-27.40", {
    counterpartyName: "Example Bistro",
    description: "Lunch",
  });
  const rail = await tx(checking.id, M(1, 15), "-86.00", {
    counterpartyName: "Example Rail AG",
    description: "Season ticket",
  });
  await assignCategory(userId, rail.id, transport.id);
  const pharmacy = await tx(checking.id, M(1, 18), "-42.30", {
    counterpartyName: "Example Pharmacy",
    description: "Prescription",
    note: "Keep the receipt for the tax return",
  });
  await assignCategory(userId, pharmacy.id, pharmacyCategory.id);
  await tx(checking.id, M(1, 23), "-23.90", {
    counterpartyName: "Example Hardware Store",
    description: "Tools",
  });

  // Added by hand, with a note.
  const gift = await createManualTransaction(userId, checking.id, {
    bookingDate: addDays(today, -6),
    valueDate: null,
    amount: amount("50.00"),
    counterpartyName: "Alice Example",
    counterpartyIban: null,
    description: "Birthday gift",
    reference: null,
    note: "Cash from relatives",
  });
  await assignCategory(userId, gift.id, gifts.id);
  await createManualTransaction(userId, checking.id, {
    bookingDate: addDays(today, -8),
    valueDate: addDays(today, -7),
    amount: amount("-18.50"),
    counterpartyName: null,
    counterpartyIban: null,
    description: null,
    reference: null,
    note: null,
  });
  await updateTransaction(userId, recentGrocer.id, {
    note: "Paid with the loyalty card",
  });

  // Credit card: a foreign-currency charge, and a charge that was reversed.
  await tx(creditCard.id, addDays(today, -12), "-310.00", {
    counterpartyName: "Example Airline",
    description: "Flight",
    originalAmount: amount("-335.00"),
    originalCurrency: "EUR",
    referenceType: null,
  });
  await tx(creditCard.id, addDays(today, -9), "-45.00", {
    counterpartyName: "Example Online Shop",
    description: "Order 1001",
  });
  await tx(creditCard.id, addDays(today, -8), "45.00", {
    counterpartyName: "Example Online Shop",
    description: "Order 1001 cancelled",
    reversal: true,
  });

  // Euro account.
  await tx(euro.id, addDays(today, -15), "-23.50", {
    counterpartyName: "Example Euro Shop",
    currency: "EUR",
    description: "Groceries",
  });
  await tx(euro.id, addDays(today, -40), "250.00", {
    counterpartyName: "Example Euro Employer",
    currency: "EUR",
    description: "Refund",
  });
  await tx(joint.id, addDays(today, -11), "-120.00", {
    counterpartyName: "Example Grocer",
    description: "Weekly shop",
  });
  await tx(archived.id, addDays(today, -300), "10.00", {
    counterpartyName: "Example Closing Bonus",
  });
  await archiveAccount(userId, archived.id);

  // Transfers between own accounts: mirrored, paired, waiting for an FX amount,
  // and one that names an account's IBAN with no counterpart.
  await tx(checking.id, addDays(today, -20), "-500.00", {
    counterpartyName: "Example Savings",
    counterpartyIban: EXAMPLE_IBAN_THIRD,
    description: "Move to savings",
  });
  await tx(checking.id, addDays(today, -14), "-300.00", {
    counterpartyName: "Example Joint Account",
    counterpartyIban: FOREIGN_IBANS[4],
    description: "Share of the shopping",
  });
  await tx(joint.id, addDays(today, -14), "300.00", {
    counterpartyName: "Example Checking",
    counterpartyIban: EXAMPLE_IBAN,
    description: "Share of the shopping",
  });
  await tx(checking.id, addDays(today, -6), "-200.00", {
    counterpartyName: "Example Euro Account",
    counterpartyIban: FOREIGN_IBANS[0],
    description: "Top up euros",
  });
  await tx(checking.id, addDays(today, -5), "-250.00", {
    counterpartyName: "Example Pension Fund",
    counterpartyIban: FOREIGN_IBANS[3],
    description: "Voluntary payment",
  });
  await linkTransfers(userId, {});
  // Looks like the other side of the euro top-up that waits for its amount.
  await tx(euro.id, addDays(today, -5), "210.00", {
    currency: "EUR",
    description: "Incoming transfer",
  });

  // Balances reported by the institution.
  await createSnapshot(userId, savings.id, {
    date: addDays(today, -60),
    amount: amount("12000.00"),
    note: "Year-end statement",
  });
  await createSnapshot(userId, savings.id, {
    date: addDays(today, -10),
    amount: amount("12510.00"),
    note: null,
  });
  await createSnapshot(userId, pension.id, {
    date: addDays(today, -45),
    amount: amount("46250.00"),
    note: "Annual certificate",
  });
  await createSnapshot(userId, euro.id, {
    date: addDays(today, -30),
    amount: amount("1000.00"),
    note: null,
  });

  await applyRulesToUncategorized(userId);

  // --- recurring payments -------------------------------------------------

  await syncRecurring(userId);
  const series = await listRecurring(userId, today);
  const rent = series.find((s) => s.name.includes("Property"));
  const stream = series.find((s) => s.name.includes("Streaming"));
  const pay = series.find((s) => s.name.includes("Employer"));
  if (rent) await confirmSeries(userId, rent.id);
  if (pay) await confirmSeries(userId, pay.id);
  if (stream) await dismissSeries(userId, stream.id);

  // --- bills ----------------------------------------------------------------

  const store = await storeDocument(
    userId,
    fixture("bills/scanned-qr-bill.pdf"),
    "invoice-2001.pdf",
    "application/pdf",
  );
  const openBill = await createBill(
    userId,
    billInput({
      creditorName: "Example Supplier AG",
      creditorIban: EXAMPLE_IBAN_OTHER,
      amount: amount("1949.75"),
      issueDate: addDays(today, -18),
      dueDate: addDays(today, 12),
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
      message: "Invoice 2001",
      invoiceNumber: "2001",
      expectedAccountId: checking.id,
      notes: "Ask for a discount next time",
    }),
    {
      documentId: store.id,
      extraction: { source: "qr", warnings: ["Example warning"] },
      external: {
        externalSource: "example-dms",
        externalRef: "doc-2001",
        externalUrl: "https://dms.example.org/documents/2001",
      },
    },
  );
  await createLink(userId, "bill", openBill.id, {
    source: "example-dms",
    label: "Invoice 2001 in the archive",
    url: "https://dms.example.org/documents/2001",
  });
  const exactPayment = await tx(checking.id, addDays(today, -1), "-1949.75", {
    counterpartyName: "Example Supplier AG",
    counterpartyIban: EXAMPLE_IBAN_OTHER,
    reference: EXAMPLE_QRR,
    referenceType: "QRR",
    description: "Invoice 2001",
  });
  const lookalike = await tx(checking.id, addDays(today, -3), "-1949.75", {
    counterpartyName: "Example Supplier AG",
    counterpartyIban: EXAMPLE_IBAN_OTHER,
    description: "Invoice 2001 (first try)",
  });
  await dismissSuggestion(userId, openBill.id, lookalike.id);
  await createLink(userId, "transaction", exactPayment.id, {
    source: "example-dms",
    label: "Payment confirmation",
    url: "https://dms.example.org/payments/77",
  });

  const overdueBill = await createBill(
    userId,
    billInput({
      creditorName: "Example Utilities GmbH",
      creditorIban: FOREIGN_IBANS[4],
      amount: amount("85.50"),
      issueDate: addDays(today, -50),
      dueDate: addDays(today, -20),
      reference: EXAMPLE_SCOR,
      referenceType: "SCOR",
      invoiceNumber: "U-77",
    }),
  );

  const paidBill = await createBill(
    userId,
    billInput({
      creditorName: "Example Tax Office",
      amount: amount("1200.00"),
      issueDate: addDays(today, -40),
      dueDate: addDays(today, -9),
      taxYear,
      notes: "Final instalment",
    }),
  );
  const paidPayment = await tx(checking.id, addDays(today, -10), "-1200.00", {
    counterpartyName: "Example Tax Office",
    description: "Final instalment",
  });
  await allocateFromInput(
    userId,
    paidBill.id,
    paidPayment.id,
    "1200.00",
    "user",
  );

  const paidAutoBill = await createBill(
    userId,
    billInput({
      creditorName: "Example Insurance AG",
      creditorIban: FOREIGN_IBANS[2],
      amount: amount("120.00"),
      issueDate: addDays(today, -30),
      dueDate: addDays(today, -7),
      reference: makeQrr(4242),
      referenceType: "QRR",
    }),
  );
  await tx(checking.id, addDays(today, -8), "-120.00", {
    counterpartyName: "Example Insurance AG",
    counterpartyIban: FOREIGN_IBANS[2],
    reference: makeQrr(4242),
    referenceType: "QRR",
    description: "Premium",
  });
  await runAutoMatching(userId);

  const partialBill = await createBill(
    userId,
    billInput({
      creditorName: "Example Dental Clinic",
      amount: amount("600.00"),
      issueDate: addDays(today, -25),
      dueDate: addDays(today, 5),
      expectedAccountId: checking.id,
    }),
  );
  const partialPayment = await tx(checking.id, addDays(today, -4), "-250.00", {
    counterpartyName: "Example Dental Clinic",
    description: "Instalment 1",
  });
  await allocate(
    userId,
    partialBill.id,
    partialPayment.id,
    amount("250.00"),
    "user",
  );

  const cancelledBill = await createBill(
    userId,
    billInput({
      creditorName: "Example Gym Ltd",
      amount: amount("49.00"),
      dueDate: addDays(today, -60),
    }),
  );
  await cancelBill(userId, cancelledBill.id);

  const creditNote = await createBill(
    userId,
    billInput({
      kind: "credit_note",
      creditorName: "Example Supplier AG",
      amount: amount("75.00"),
      issueDate: addDays(today, -15),
      invoiceNumber: "CN-5",
      notes: "Refund for a returned item",
    }),
  );

  // --- forecast -------------------------------------------------------------

  await createPlannedItem(userId, {
    label: "Car service",
    date: addDays(today, 10),
    direction: "expense",
    amount: "450.00",
    accountId: wallet.id,
    currency: null,
  });
  await createPlannedItem(userId, {
    label: "Tax refund",
    date: addDays(today, 40),
    direction: "income",
    amount: "300.00",
    accountId: null,
    currency: "CHF",
  });
  await createPlannedItem(userId, {
    label: "Holiday booking",
    date: addDays(today, 25),
    direction: "expense",
    amount: "900.00",
    accountId: checking.id,
    currency: null,
  });
  await createPlannedItem(userId, {
    label: "Conference fee",
    date: addDays(today, 33),
    direction: "expense",
    amount: "120.00",
    accountId: null,
    currency: "USD",
  });
  await saveAccountSettings(userId, {
    accountId: checking.id,
    threshold: "1000.00",
    defaultPayment: "on",
  });
  await saveAccountSettings(userId, {
    accountId: wallet.id,
    threshold: "",
    defaultPayment: "",
  });

  // --- investments ----------------------------------------------------------

  const etf = await seedSecurity(userId, {
    name: "Example World ETF",
    kind: "etf",
    isin: "EX0000000013",
    symbol: "EXWLD",
    currency: "CHF",
  });
  const stock = await seedSecurity(userId, {
    name: "Example Stock Corp",
    kind: "stock",
    isin: null,
    symbol: null,
    currency: "USD",
  });
  const bond = await seedSecurity(userId, {
    name: "Example Bond Fund",
    kind: "bond",
    isin: "EX0000000021",
    symbol: null,
    currency: "CHF",
  });
  await seedTrade(userId, investment.id, etf.id, {
    date: addDays(today, -150),
    qty: "10",
    price: "100",
    fees: 5,
    amount: 100500,
    note: "First purchase",
  });
  await seedTrade(userId, investment.id, etf.id, {
    date: addDays(today, -100),
    qty: "5",
    price: "104.50",
    fees: 5,
    amount: 52750,
  });
  await seedTrade(userId, investment.id, etf.id, {
    date: addDays(today, -60),
    side: "split",
    split: { new: 2, old: 1 },
    amount: 0,
    note: "2:1 split",
  });
  await seedTrade(userId, investment.id, etf.id, {
    date: addDays(today, -20),
    side: "sell",
    qty: "6",
    price: "55.00",
    fees: 4,
    amount: 32600,
  });
  await seedTrade(userId, investment.id, stock.id, {
    date: addDays(today, -90),
    qty: "20",
    price: "50",
    fees: 9,
    amount: 88900,
  });
  await createManualTransaction(userId, investment.id, {
    bookingDate: addDays(today, -110),
    valueDate: null,
    amount: amount("-12.50"),
    counterpartyName: "Example Broker",
    counterpartyIban: null,
    description: "Custody fee",
    reference: null,
    note: null,
  });
  await seedManualPrice(userId, etf.id, addDays(today, -30), "57.20");
  await seedProviderPrice(userId, etf.id, addDays(today, -3), "58.40");
  await seedProviderPrice(userId, etf.id, addDays(today, -4), "58.10");
  await seedManualPrice(userId, stock.id, addDays(today, -5), "54.00");
  await upsertFxRates(userId, [
    {
      base: "USD",
      quote: "CHF",
      date: addDays(today, -90),
      rate: parseFixed("0.89"),
    },
    {
      base: "USD",
      quote: "CHF",
      date: addDays(today, -5),
      rate: parseFixed("0.87"),
    },
  ]);

  // --- pillar 3a ------------------------------------------------------------

  const depositReference = makeQrr(21);
  const portfolioA = await seedPortfolio(userId, pillar3a.id, {
    name: "Example Portfolio A",
    number: "P-001",
    strategy: "Equity 60",
    depositReference,
    openedOn: addDays(today, -400),
    sortOrder: 0,
  });
  const portfolioB = await seedPortfolio(userId, pillar3a.id, {
    name: "Example Portfolio B",
    number: null,
    strategy: null,
    depositReference: null,
    openedOn: addDays(today, -700),
    sortOrder: 1,
  });
  await setValues(
    userId,
    pillar3a.id,
    addDays(today, -60),
    [
      { portfolioId: portfolioA.id, amount: amount("8200.00") },
      { portfolioId: portfolioB.id, amount: amount("3000.00") },
    ],
    "Quarterly statement",
  );
  await setValues(userId, pillar3a.id, addDays(today, -4), [
    { portfolioId: portfolioA.id, amount: amount("8460.00") },
  ]);
  await closePortfolio(userId, portfolioB.id, {
    closedOn: addDays(today, -30),
    closeReason: "transfer",
  });
  await setYearSetting(userId, {
    year: thisYear,
    deduction: "large",
    earnedIncome: amount("90000.00"),
  });
  await setYearSetting(userId, {
    year: taxYear,
    deduction: "small",
    earnedIncome: null,
  });
  const detected3a = await tx(checking.id, thisYearOn("01-15"), "-3000.00", {
    counterpartyName: "Example Pillar 3a Foundation",
    counterpartyIban: EXAMPLE_IBAN_OTHER,
    reference: depositReference,
    referenceType: "QRR",
    description: "Pillar 3a payment",
  });
  await updateDetectedContribution(userId, detected3a.id, {
    date: detected3a.bookingDate,
    kind: "ordinary",
    gapYears: [],
    note: "Paid from checking",
  });
  await addManualContribution(userId, {
    portfolioId: portfolioA.id,
    date: `${taxYear}-12-10`,
    amount: amount("5258.00"),
    kind: "ordinary",
    gapYears: [],
    note: "Paid from an account outside Kept",
  });
  // Paid after 20 December: the provider may credit it in January.
  await tx(checking.id, `${taxYear}-12-23`, "-500.00", {
    counterpartyName: "Example Pillar 3a Foundation",
    counterpartyIban: EXAMPLE_IBAN_OTHER,
    reference: depositReference,
    referenceType: "QRR",
    description: "Pillar 3a payment",
  });
  // A payment that was annotated and then lost its reference leaves its annotation behind.
  const removedPayment = await createManualTransaction(userId, checking.id, {
    bookingDate: thisYearOn("01-10"),
    valueDate: null,
    amount: amount("-200.00"),
    counterpartyName: "Example Pillar 3a Foundation",
    counterpartyIban: null,
    description: "Pillar 3a payment (entered twice)",
    reference: depositReference,
    note: null,
  });
  await updateDetectedContribution(userId, removedPayment.id, {
    date: removedPayment.bookingDate,
    kind: "ordinary",
    gapYears: [],
    note: "Entered twice",
  });
  await updateTransaction(userId, removedPayment.id, {
    bookingDate: removedPayment.bookingDate,
    valueDate: null,
    amount: removedPayment.amount,
    counterpartyName: removedPayment.counterpartyName,
    counterpartyIban: null,
    description: removedPayment.description,
    reference: null,
    note: null,
  });
  await tx(checking.id, thisYearOn("01-20"), "-1500.00", {
    counterpartyName: "Example Pillar 3a Foundation",
    counterpartyIban: EXAMPLE_IBAN_OTHER,
    reference: depositReference,
    referenceType: "QRR",
    description: "Pillar 3a buy-in",
  }).then((buyIn) =>
    updateDetectedContribution(userId, buyIn.id, {
      date: buyIn.bookingDate,
      kind: "buy_in",
      gapYears: [taxYear],
      note: null,
    }),
  );

  // --- taxes ----------------------------------------------------------------

  await upsertTaxYear(userId, {
    year: taxYear,
    authority: "Example Tax Office",
    currency: "CHF",
    assessedTotal: amount("5500.00"),
    notes: "Assessment received, second instalment still disputed",
  });
  const taxPayments: [string, string][] = [
    [`${taxYear}-03-10`, "-3200.00"],
    [`${taxYear}-09-14`, "-1800.00"],
    [`${taxYear}-11-02`, "-900.00"],
  ];
  for (const [index, [date, value]] of taxPayments.entries()) {
    const payment = await tx(checking.id, date, value, {
      counterpartyName: "Example Tax Office",
      description: `Provisional tax ${taxYear}`,
      reference: index === 0 ? "EX-TAX-1" : null,
    });
    await setTransactionTaxYear(userId, payment.id, taxYear);
  }
  await addTaxCredit(userId, taxYear, {
    bookingDate: `${taxYear}-03-12`,
    amount: amount("3200.00"),
    reference: "EX-TAX-1",
    description: "First instalment",
  });
  await addTaxCredit(userId, taxYear, {
    bookingDate: `${taxYear}-09-20`,
    amount: amount("1500.00"),
    reference: null,
    description: "Second instalment",
  });
  await addTaxCredit(userId, taxYear, {
    bookingDate: `${taxYear}-12-20`,
    amount: amount("-50.00"),
    reference: null,
    description: null,
  });
  // A credit the office counted that looks like an untagged payment of yours.
  await addTaxCredit(userId, taxYear, {
    bookingDate: `${taxYear}-10-05`,
    amount: amount("640.00"),
    reference: null,
    description: "Corrected assessment",
  });
  await tx(checking.id, `${taxYear}-10-01`, "-640.00", {
    counterpartyName: "Example Tax Office",
    description: "Payment on account",
  });
  await tx(checking.id, `${taxYear}-02-11`, "-480.00", {
    counterpartyName: "Example Dental Clinic",
    description: "Treatment",
  }).then((t) => assignCategory(userId, t.id, health.id));
  await tx(checking.id, `${taxYear}-06-18`, "-150.00", {
    counterpartyName: "Example Charity",
    description: "Donation",
  });
  const excludedDonation = await tx(checking.id, `${taxYear}-07-04`, "-75.00", {
    counterpartyName: "Example Charity",
    description: "Donation (private)",
  });
  const lateDonation = await tx(checking.id, thisYearOn("01-02"), "-90.00", {
    counterpartyName: "Example Charity",
    description: "Donation paid in January",
  });
  await applyRulesToUncategorized(userId);
  await setTransactionDeductionExcluded(userId, excludedDonation.id, true);
  await setTransactionDeductionYear(userId, lateDonation.id, taxYear);

  // --- notifications, tokens, account -----------------------------------------

  await saveSettings(userId, {
    billDueEnabled: true,
    billDueDays: 5,
    billOverdueEnabled: true,
    budgetEnabled: true,
    budgetPercent: 90,
    staleImportEnabled: false,
    staleImportDays: 21,
  });
  await saveChannel(userId, "ntfy", {
    serverUrl: "https://ntfy.example.org",
    topic: "kept-example",
    token: "example-ntfy-token",
  });
  await recordChannelResult(userId, "ntfy", null);
  await saveChannel(userId, "webhook", {
    url: "https://hooks.example.org/kept",
    secret: "example-webhook-secret",
  });
  await recordChannelResult(userId, "webhook", "http_500");

  const token = await seedToken(userId, ["bills:read", "transactions:read"], {
    name: "Example script",
    categoryIds: [groceries.id],
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  assertTokenAccepted(await verifyApiToken(token.token));
  const revoked = await createApiToken(userId, {
    name: "Example old token",
    scopes: ["accounts:read"],
    categoryIds: null,
    expiresAt: null,
  });
  await revokeApiToken(userId, revoked.info.id);
  await addPasskey(userId);
  await enableTotp(actor);
  await recordAdminAction(actor, "user_create", {
    target: { id: userId, username: actor.username },
    details: "role=admin",
  });

  // --- pending imports --------------------------------------------------------

  const statement = await uploadFixture(
    userId,
    checking.id,
    "camt053/overlap-b.xml",
  );
  const csv = await uploadFixture(userId, wallet.id, "csv/overlap-b.csv");

  return {
    today,
    taxYear,
    budgetMonth: monthOf(today, 1),
    institutions: { bank: bank.id, broker: broker.id },
    accounts: {
      checking: checking.id,
      savings: savings.id,
      creditCard: creditCard.id,
      investment: investment.id,
      pillar3a: pillar3a.id,
      pension: pension.id,
      euro: euro.id,
      joint: joint.id,
      wallet: wallet.id,
      archived: archived.id,
    },
    bills: {
      open: openBill.id,
      overdue: overdueBill.id,
      paid: paidBill.id,
      paidAuto: paidAutoBill.id,
      partial: partialBill.id,
      cancelled: cancelledBill.id,
      creditNote: creditNote.id,
    },
    pending: { statement, csv },
    securities: { etf: etf.id, stock: stock.id, bond: bond.id },
    documentId: store.id,
    focusTransactionId: exactPayment.id,
    rest: { token: token.info.id, revokedToken: revoked.info.id },
  };
}

/** Rows for a second user. Every name carries the marker, nothing of it may reach another user's capture. */
export async function seedOtherUserData(userId: string): Promise<void> {
  const today = localToday();
  const bank = await seedInstitution(userId, `${OTHER_USER_MARKER} Bank`);
  const checking = await seedAccount(userId, {
    name: `${OTHER_USER_MARKER} Checking`,
    iban: FOREIGN_IBANS[6],
    institutionId: bank.id,
    openingBalance: minor(99_900),
  });
  const food = await createCategory(userId, {
    name: `${OTHER_USER_MARKER} Food`,
    kind: "expense",
    parentId: null,
    color: null,
    icon: null,
  });
  for (const back of [3, 2, 1]) {
    const row = await seedImportedTransaction(userId, checking.id, {
      bookingDate: `${monthOf(today, back)}-05`,
      amount: minor(-31_337),
      counterpartyName: `${OTHER_USER_MARKER} Counterparty`,
      description: `${OTHER_USER_MARKER} Description`,
      note: `${OTHER_USER_MARKER} Note`,
    });
    await assignCategory(userId, row.id, food.id);
  }
  await createBudget(userId, {
    categoryId: food.id,
    currency: "CHF",
    amount: minor(50_000),
  });
  await createBill(
    userId,
    billInput({
      creditorName: `${OTHER_USER_MARKER} Supplier`,
      amount: minor(31_337),
      dueDate: addDays(today, 3),
    }),
  );
  await upsertTaxYear(userId, {
    year: Number(today.slice(0, 4)) - 1,
    authority: `${OTHER_USER_MARKER} Tax Office`,
    currency: "CHF",
    assessedTotal: minor(31_337),
    notes: `${OTHER_USER_MARKER} notes`,
  });
  await saveChannel(userId, "ntfy", {
    serverUrl: "https://ntfy.example.org",
    topic: `${OTHER_USER_MARKER}-topic`,
  });
}
