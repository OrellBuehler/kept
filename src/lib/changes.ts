/**
 * How the change log is shown: one sentence per action, a label per field, and
 * the formatting of before / after values. Client-safe (no server imports);
 * `changes.test.ts` fails when an action has no label.
 */
import { formatShare, type Minor } from "$lib/money";

export const ACTION_LABELS: Record<string, string> = {
  "bill.create": "Created a bill",
  "bill.update": "Edited a bill",
  "bill.cancel": "Cancelled a bill",
  "bill.uncancel": "Restored a cancelled bill",
  "bill.delete": "Deleted a bill",
  "allocation.create": "Matched a payment to a bill",
  "allocation.auto_match": "Matched a payment to a bill automatically",
  "allocation.delete": "Removed a payment from a bill",
  "match_dismissal.create": "Dismissed a match suggestion",
  "match_dismissal.delete": "Brought back a dismissed match suggestion",
  "transaction.create": "Added a payment",
  "transaction.update": "Edited a payment",
  "transaction.delete": "Deleted a payment",
  "category.create": "Created a category",
  "category.update": "Edited a category",
  "category.delete": "Deleted a category",
  "category_rule.create": "Created a category rule",
  "category_rule.update": "Edited a category rule",
  "category_rule.delete": "Deleted a category rule",
  "category_rule.apply": "Applied category rules to payments",
  "account.create": "Created an account",
  "account.update": "Edited an account",
  "account.archive": "Archived an account",
  "account.unarchive": "Unarchived an account",
  "account.delete": "Deleted an account",
  "institution.create": "Created an institution",
  "institution.update": "Edited an institution",
  "institution.delete": "Deleted an institution",
  "snapshot.create": "Recorded a balance",
  "snapshot.delete": "Deleted a recorded balance",
  "budget.create": "Created a budget",
  "budget.update": "Edited a budget",
  "budget.delete": "Deleted a budget",
  "planned_item.create": "Added a planned item",
  "planned_item.update": "Edited a planned item",
  "planned_item.delete": "Deleted a planned item",
  "forecast_setting.update": "Changed a forecast setting",
  "recurring_series.update": "Edited a recurring payment",
  "tax_year.create": "Added a tax year",
  "tax_year.update": "Edited a tax year",
  "tax_year.delete": "Deleted a tax year",
  "tax_credit.create": "Added a tax office credit",
  "tax_credit.delete": "Deleted a tax office credit",
  "deduction_mapping.update": "Changed a tax deduction mapping",
  "preference.update": "Changed preferences",
  "import.confirm": "Confirmed an import",
  "import.undo": "Undid an import",
  "external_link.create": "Added a link",
  "external_link.update": "Edited a link",
  "external_link.delete": "Removed a link",
};

/** Falls back to the raw action so a new one is readable (and the test fails) rather than blank. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Entity types for the filter, singular for a row and plural for the menu. */
export const ENTITY_LABELS: Record<string, { one: string; many: string }> = {
  bill: { one: "Bill", many: "Bills" },
  allocation: { one: "Bill payment", many: "Bill payments" },
  match_dismissal: { one: "Dismissed match", many: "Dismissed matches" },
  transaction: { one: "Payment", many: "Payments" },
  category: { one: "Category", many: "Categories" },
  category_rule: { one: "Category rule", many: "Category rules" },
  account: { one: "Account", many: "Accounts" },
  institution: { one: "Institution", many: "Institutions" },
  snapshot: { one: "Balance", many: "Balances" },
  budget: { one: "Budget", many: "Budgets" },
  planned_item: { one: "Planned item", many: "Planned items" },
  forecast_setting: { one: "Forecast setting", many: "Forecast settings" },
  recurring_series: { one: "Recurring payment", many: "Recurring payments" },
  tax_year: { one: "Tax year", many: "Tax years" },
  tax_credit: { one: "Tax office credit", many: "Tax office credits" },
  deduction_mapping: { one: "Deduction mapping", many: "Deduction mappings" },
  preference: { one: "Preferences", many: "Preferences" },
  import: { one: "Import", many: "Imports" },
  external_link: { one: "Link", many: "Links" },
};

export function entityLabel(type: string): string {
  return ENTITY_LABELS[type]?.one ?? humanize(type);
}

export const ACTOR_KIND_LABELS = {
  web: "You (web)",
  app: "App",
  api: "API token",
  mcp: "Assistant (MCP)",
  system: "System",
} as const;

/** The actor menu: `all`, then one entry per kind. */
export const ACTOR_FILTER_LABELS = {
  web: "Me (web)",
  mcp: "Assistant (MCP)",
  api: "API tokens",
  app: "Mobile app",
  system: "System",
} as const;

export interface ActorLike {
  kind: string;
  label: string | null;
}

/** "You (web)", "Assistant (MCP): Claude Code" and so on. */
export function actorText(actor: ActorLike): string {
  const base =
    (ACTOR_KIND_LABELS as Record<string, string>)[actor.kind] ?? actor.kind;
  return actor.label ? `${base}: ${actor.label}` : base;
}

/** `camelCase` or `snake_case` as a sentence start: "creditorName" -> "Creditor name". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const FIELD_LABELS: Record<string, string> = {
  kind: "Kind",
  creditorName: "Creditor",
  creditorIban: "Creditor IBAN",
  amount: "Amount",
  currency: "Currency",
  issueDate: "Issue date",
  dueDate: "Due date",
  reference: "Payment reference",
  referenceType: "Reference type",
  message: "Message",
  invoiceNumber: "Invoice number",
  cancelled: "Cancelled",
  documentId: "Attached document",
  expectedAccountId: "Expected account",
  notes: "Notes",
  note: "Note",
  taxYear: "Tax year",
  deductionYear: "Deduction year",
  deductionExcluded: "Excluded from deductions",
  externalSource: "External source",
  externalRef: "External reference",
  externalUrl: "External link",
  extraction: "Extracted data",
  createdAt: "Created",
  billId: "Bill",
  transactionId: "Payment",
  origin: "Matched",
  name: "Name",
  parentId: "Parent category",
  color: "Colour",
  icon: "Icon",
  categoryId: "Category",
  accountId: "Account",
  priority: "Priority",
  counterpartyContains: "Counterparty contains",
  descriptionContains: "Description contains",
  counterpartyIban: "Counterparty IBAN",
  amountSign: "Direction",
  type: "Type",
  iban: "IBAN",
  institutionId: "Institution",
  contractNumber: "Contract number",
  websiteUrl: "Website",
  depositIban: "Deposit IBAN",
  openingBalance: "Opening balance",
  openingDate: "Opening date",
  noticeMonths: "Notice period (months)",
  freeWithdrawal: "Free withdrawal",
  freeWithdrawalPeriod: "Free withdrawal period",
  fillFromTransfers: "Fill from transfers",
  tradesMoveCash: "Trades move cash",
  archived: "Archived",
  sortOrder: "Sort order",
  shareBps: "Ownership share",
  sharedWith: "Shared with",
  transactionCount: "Payments in it",
  date: "Date",
  label: "Label",
  bookingDate: "Booking date",
  valueDate: "Value date",
  description: "Description",
  counterpartyName: "Counterparty",
  threshold: "Low balance warning",
  defaultPayment: "Default account for bills",
  status: "Status",
  cadence: "Cadence",
  authority: "Tax office",
  assessedTotal: "Assessed total",
  year: "Year",
  deductionType: "Deduction type",
  source: "Source",
  url: "Link",
  linkedType: "Linked to",
  linkedId: "Linked record",
  locale: "Language and format",
  blurAmounts: "Blur amounts",
  defaultCurrency: "Default currency",
  ibanDisplay: "IBAN display",
  pageSize: "Page size",
  tooLarge: "Too large to restore",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? humanize(key);
}

/** Fields holding minor units; the currency comes from the same record. */
export const MONEY_FIELDS: ReadonlySet<string> = new Set([
  "amount",
  "openingBalance",
  "freeWithdrawal",
  "threshold",
  "assessedTotal",
]);

const IBAN_FIELDS: ReadonlySet<string> = new Set([
  "iban",
  "creditorIban",
  "depositIban",
  "counterpartyIban",
]);

/** Text values that are one of a fixed set: shown as a word, not as `snake_case`. */
const ENUM_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "type",
  "status",
  "origin",
  "cadence",
  "amountSign",
  "referenceType",
  "source",
  "linkedType",
  "deductionType",
  "freeWithdrawalPeriod",
]);

export interface ChangeReferencesLike {
  categories: Record<string, string>;
  accounts: Record<string, { name: string; currency: string }>;
  bills: Record<string, { name: string | null; currency: string }>;
  institutions: Record<string, string>;
  transactions: Record<
    string,
    { name: string | null; bookingDate: string; currency: string }
  >;
}

export interface Formatters {
  amount(value: Minor, currency: string): string;
  date(iso: string): string;
  dateTime(ms: number): string;
  /** The display form of an IBAN, or null when the user hides them. */
  iban(iban: string): string | null;
}

export interface FormatContext extends Formatters {
  refs: ChangeReferencesLike;
}

export const EMPTY = "–";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 240;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function isTruncated(value: unknown): value is { count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { truncated?: unknown }).truncated === true &&
    typeof (value as { count?: unknown }).count === "number"
  );
}

/** What a reference field points at, by name; "(deleted)" when the record is gone. */
function reference(
  field: string,
  id: string,
  refs: ChangeReferencesLike,
): string | null {
  switch (field) {
    case "categoryId":
    case "parentId":
      return refs.categories[id] ?? "Deleted category";
    case "accountId":
    case "expectedAccountId":
      return refs.accounts[id]?.name ?? "Deleted account";
    case "institutionId":
      return refs.institutions[id] ?? "Deleted institution";
    case "billId": {
      const bill = refs.bills[id];
      return bill ? (bill.name ?? "Unnamed bill") : "Deleted bill";
    }
    case "transactionId": {
      const tx = refs.transactions[id];
      if (!tx) return "Deleted payment";
      return tx.name ? `${tx.name}, ${tx.bookingDate}` : tx.bookingDate;
    }
    default:
      return null;
  }
}

/**
 * The currency an amount in `snapshot` is in: its own `currency`, else the
 * currency of the account, bill or payment it points at, else of the entity.
 */
export function currencyOf(
  snapshots: readonly (Record<string, unknown> | null)[],
  entity: { type: string; id: string },
  refs: ChangeReferencesLike,
): string | null {
  for (const s of snapshots) {
    if (typeof s?.currency === "string") return s.currency;
  }
  for (const s of snapshots) {
    if (!s) continue;
    for (const key of ["accountId", "expectedAccountId"]) {
      const v = s[key];
      if (typeof v === "string" && refs.accounts[v]) {
        return refs.accounts[v].currency;
      }
    }
    if (typeof s.billId === "string" && refs.bills[s.billId]) {
      return refs.bills[s.billId]!.currency;
    }
    if (
      typeof s.transactionId === "string" &&
      refs.transactions[s.transactionId]
    ) {
      return refs.transactions[s.transactionId]!.currency;
    }
  }
  if (entity.type === "account")
    return refs.accounts[entity.id]?.currency ?? null;
  if (entity.type === "bill") return refs.bills[entity.id]?.currency ?? null;
  if (entity.type === "transaction") {
    return refs.transactions[entity.id]?.currency ?? null;
  }
  return null;
}

/**
 * One before / after value as text. Amounts go through `amount` (minor units
 * and a currency, never a float); when the currency cannot be told the number
 * is shown as it is stored. Unknown shapes fall back to plain text or JSON.
 */
export function formatChangeValue(
  field: string,
  value: unknown,
  ctx: FormatContext,
  currency: string | null,
): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  if (isTruncated(value)) {
    return `${value.count} ${value.count === 1 ? "item" : "items"}`;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (MONEY_FIELDS.has(field) && Number.isInteger(value)) {
      return currency
        ? ctx.amount(value as Minor, currency)
        : `${value} (minor units)`;
    }
    if (field === "shareBps") return formatShare(value);
    if (field.endsWith("At") && Number.isFinite(value)) {
      return ctx.dateTime(value);
    }
    return String(value);
  }
  if (typeof value === "string") {
    const ref = reference(field, value, ctx.refs);
    if (ref !== null) return ref;
    if (IBAN_FIELDS.has(field)) return ctx.iban(value) ?? "Hidden";
    if (ISO_DATE.test(value)) return ctx.date(value);
    if (ENUM_FIELDS.has(field)) return humanize(value);
    return clip(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY;
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return clip(
        value.map((v) => formatChangeValue(field, v, ctx, currency)).join(", "),
      );
    }
    return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  }
  return clip(JSON.stringify(value));
}

export interface DiffRow {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

interface DiffEntry {
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * The fields of an entry, one row each: updates show before and after,
 * creates only after, deletes only before. Unknown fields are kept.
 */
export function diffRows(entry: DiffEntry, ctx: FormatContext): DiffRow[] {
  const currency = currencyOf(
    [entry.after, entry.before],
    { type: entry.entityType, id: entry.entityId },
    ctx.refs,
  );
  const keys = [
    ...new Set([
      ...Object.keys(entry.after ?? {}),
      ...Object.keys(entry.before ?? {}),
    ]),
  ];
  const whole = entry.before === null || entry.after === null;
  const rows = keys.map((field) => ({
    field,
    label: fieldLabel(field),
    before: entry.before
      ? formatChangeValue(field, entry.before[field], ctx, currency)
      : null,
    after: entry.after
      ? formatChangeValue(field, entry.after[field], ctx, currency)
      : null,
  }));
  // A create or delete lists the whole record; fields that were never set are noise.
  return whole ? rows.filter((r) => (r.before ?? r.after) !== EMPTY) : rows;
}

/** What a revert of this entry does, for the confirmation text. */
export function revertEffect(action: string, entityLabelText: string): string {
  const what = entityLabelText.toLowerCase();
  if (action === "category_rule.apply") {
    return "The payments this filed will go back to how they were.";
  }
  if (action.endsWith(".create") || action === "allocation.auto_match") {
    return `The ${what} that was created will be deleted again.`;
  }
  if (action.endsWith(".delete")) {
    return `The ${what} that was deleted will be restored.`;
  }
  return `The fields this changed on the ${what} will be set back to their earlier values.`;
}
