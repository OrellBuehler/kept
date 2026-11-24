import { z } from "zod";
import { ApiError, type Client, type Fields } from "./client";
import { quarterlyStatements, buildCamt053 } from "./camt";
import {
  ACCOUNTS,
  BUDGETS,
  CATEGORIES,
  FORECAST_SETTINGS,
  INSTITUTIONS,
  PORTFOLIO,
  RULES,
  TAX_YEARS,
  plannedItems,
  taxCredits,
  type AccountSpec,
  type AccountSpecKey,
} from "./dataset";
import {
  PILLAR_3A_CONTRIBUTION,
  PILLAR_3A_OPENED,
  SECURITIES,
  buildPortfolioValues,
  buildPrices,
  buildTrades,
  tradeQuantity,
} from "./investing";
import {
  HISTORY_START,
  buildLedger,
  plain,
  type BillSpec,
  type Ledger,
} from "./ledger";
import { buildInvoicePdf } from "./pdf";
import { parseAmount } from "../../src/lib/money";

export type Api = Pick<Client, "page" | "action">;

export class Interrupted extends Error {
  override name = "Interrupted";
  constructor() {
    super("interrupted");
  }
}

export interface Context {
  api: Api;
  today: string;
  log: (line: string) => void;
  /** Asked between steps; true once the user asked to stop. */
  stopped?: () => boolean;
}

const rows = <S extends z.ZodType>(schema: S) => z.array(schema);
const id = z.string().min(1);

const step = (ctx: Context, label: string, present: number, created: number) =>
  ctx.log(`${label}: ${present} present, ${created} created`);

const createdId = (result: { data: Record<string, unknown> }, what: string) => {
  const parsed = z.object({ id }).safeParse(result.data);
  if (!parsed.success) throw new Error(`${what}: the server returned no id`);
  return parsed.data.id;
};

// --- institutions and accounts -----------------------------------------------

const accountsPage = z.object({
  institutions: rows(z.object({ id, name: z.string() })),
  accounts: rows(
    z.object({
      id,
      name: z.string(),
      iban: z.string().nullable(),
      lastImportAt: z.number().nullable(),
    }),
  ),
});

export async function seedInstitutions(ctx: Context) {
  const page = await ctx.api.page("accounts", accountsPage);
  const ids = new Map(page.institutions.map((i) => [i.name, i.id]));
  let created = 0;
  for (const spec of INSTITUTIONS) {
    if (ids.has(spec.name)) continue;
    const result = await ctx.api.action("accounts", "createInstitution", {
      name: spec.name,
      color: spec.color,
      websiteUrl: spec.websiteUrl,
    });
    ids.set(spec.name, createdId(result, "institution"));
    created++;
  }
  step(ctx, "institutions", INSTITUTIONS.length - created, created);
  return ids;
}

function accountFields(
  spec: AccountSpec,
  institutionId: string,
  order: number,
) {
  const fields: Fields = {
    institutionId,
    name: spec.name,
    type: spec.type,
    currency: "CHF",
    iban: spec.iban ?? "",
    openingBalance: spec.openingBalance,
    openingDate: HISTORY_START,
    websiteUrl: spec.websiteUrl,
    sortOrder: String(order),
  };
  if (spec.depositIban) {
    fields.depositIban = spec.depositIban;
    fields.depositIbanField = "1";
  }
  if (spec.contractNumber) fields.contractNumber = spec.contractNumber;
  if (spec.noticeMonths) {
    fields.noticeMonths = spec.noticeMonths;
    fields.freeWithdrawal = spec.freeWithdrawal ?? "";
    fields.freeWithdrawalPeriod = spec.freeWithdrawalPeriod ?? "";
  }
  if (spec.fillFromTransfers) fields.fillFromTransfers = "on";
  if (spec.tradesMoveCash) fields.tradesMoveCash = "on";
  return fields;
}

export async function seedAccounts(
  ctx: Context,
  institutions: Map<string, string>,
) {
  const present = await ctx.api.page("accounts", accountsPage);
  const ids = new Map<AccountSpecKey, string>();
  let created = 0;
  for (const [order, spec] of ACCOUNTS.entries()) {
    const existing = present.accounts.find((a) => a.name === spec.name);
    if (existing) {
      ids.set(spec.key, existing.id);
      continue;
    }
    const institutionId = institutions.get(spec.institution)!;
    const result = await ctx.api.action(
      "accounts",
      "createAccount",
      accountFields(spec, institutionId, order + 1),
    );
    ids.set(spec.key, createdId(result, "account"));
    created++;
  }
  step(ctx, "accounts", ACCOUNTS.length - created, created);
  return ids;
}

// --- categories, rules, budgets ------------------------------------------------

const categoriesPage = z.object({
  categories: rows(z.object({ id, name: z.string() })),
  rules: rows(
    z.object({
      categoryId: id,
      counterpartyContains: z.string().nullable(),
      descriptionContains: z.string().nullable(),
    }),
  ),
});

export async function seedCategories(ctx: Context) {
  const page = await ctx.api.page("settings/categories", categoriesPage);
  const ids = new Map(page.categories.map((c) => [c.name, c.id]));
  let created = 0;
  for (const spec of CATEGORIES) {
    if (ids.has(spec.name)) continue;
    const fields: Fields = { name: spec.name, kind: spec.kind };
    if (spec.parent) fields.parentId = ids.get(spec.parent)!;
    if (spec.color) fields.color = spec.color;
    if (spec.icon) fields.icon = spec.icon;
    const result = await ctx.api.action(
      "settings/categories",
      "createCategory",
      fields,
    );
    ids.set(spec.name, createdId(result, "category"));
    created++;
  }
  step(ctx, "categories", CATEGORIES.length - created, created);

  let rulesCreated = 0;
  for (const spec of RULES) {
    const categoryId = ids.get(spec.category)!;
    const exists = page.rules.some(
      (r) =>
        r.categoryId === categoryId &&
        r.counterpartyContains === (spec.counterpartyContains ?? null) &&
        r.descriptionContains === (spec.descriptionContains ?? null),
    );
    if (exists) continue;
    const fields: Fields = { categoryId, priority: "100" };
    if (spec.counterpartyContains) {
      fields.counterpartyContains = spec.counterpartyContains;
    }
    if (spec.descriptionContains) {
      fields.descriptionContains = spec.descriptionContains;
    }
    if (spec.amountSign) fields.amountSign = spec.amountSign;
    await ctx.api.action("settings/categories", "createRule", fields);
    rulesCreated++;
  }
  step(ctx, "rules", RULES.length - rulesCreated, rulesCreated);
  return ids;
}

const budgetsPage = z.object({
  report: z.object({
    currencies: rows(
      z.object({
        currency: z.string(),
        rows: rows(z.object({ categoryId: id })),
      }),
    ),
  }),
});

export async function seedBudgets(
  ctx: Context,
  categories: Map<string, string>,
) {
  const page = await ctx.api.page("budgets", budgetsPage);
  const budgeted = new Set(
    page.report.currencies
      .filter((c) => c.currency === "CHF")
      .flatMap((c) => c.rows.map((r) => r.categoryId)),
  );
  let created = 0;
  for (const spec of BUDGETS) {
    const categoryId = categories.get(spec.category)!;
    if (budgeted.has(categoryId)) continue;
    await ctx.api.action("budgets", "createBudget", {
      categoryId,
      currency: "CHF",
      amount: spec.amount,
    });
    created++;
  }
  step(ctx, "budgets", BUDGETS.length - created, created);
}

// --- bills ----------------------------------------------------------------------

const billsPage = z.object({
  list: z.object({
    items: rows(
      z.object({
        id,
        creditorName: z.string().nullable(),
        invoiceNumber: z.string().nullable(),
        documentId: z.string().nullable(),
      }),
    ),
    pageCount: z.number(),
  }),
  suggestions: rows(z.unknown()),
});

async function allBills(ctx: Context) {
  const first = await ctx.api.page("bills", billsPage, { status: "all" });
  const items = [...first.list.items];
  for (let page = 2; page <= first.list.pageCount; page++) {
    const next = await ctx.api.page("bills", billsPage, {
      status: "all",
      page: String(page),
    });
    items.push(...next.list.items);
  }
  return items;
}

function pdfFor(bill: BillSpec): Fields["file"] {
  const bytes = buildInvoicePdf({
    creditor: bill.creditor,
    invoiceNumber: bill.invoiceNumber,
    issueDate: bill.issueDate,
    dueDate: bill.dueDate,
    amount: plain(bill.amount),
    currency: "CHF",
    reference: bill.reference,
    message: bill.message,
  });
  return {
    $file: {
      name: `invoice-${bill.invoiceNumber}.pdf`,
      type: "application/pdf",
      base64: Buffer.from(bytes).toString("base64"),
    },
  };
}

export async function seedBills(
  ctx: Context,
  bills: readonly BillSpec[],
  checkingId: string,
) {
  const existing = new Map(
    (await allBills(ctx)).map((b) => [
      `${b.creditorName}|${b.invoiceNumber}`,
      b,
    ]),
  );
  let created = 0;
  let documents = 0;
  for (const bill of bills) {
    let found = existing.get(`${bill.creditor}|${bill.invoiceNumber}`);
    if (!found) {
      const result = await ctx.api.action("bills/new", "create", {
        kind: "invoice",
        creditorName: bill.creditor,
        amount: plain(bill.amount),
        currency: "CHF",
        issueDate: bill.issueDate,
        dueDate: bill.dueDate,
        reference: bill.reference,
        referenceType: "SCOR",
        message: bill.message,
        invoiceNumber: bill.invoiceNumber,
        expectedAccountId: checkingId,
        taxYear: bill.taxYear === null ? "" : String(bill.taxYear),
      });
      const billId = z
        .string()
        .regex(/^\/bills\/([\w-]+)$/)
        .parse(result.redirect)
        .slice("/bills/".length);
      found = {
        id: billId,
        creditorName: bill.creditor,
        invoiceNumber: bill.invoiceNumber,
        documentId: null,
      };
      created++;
    }
    if (bill.document && found.documentId === null) {
      await ctx.api.action(`bills/${found.id}`, "attachDocument", {
        file: pdfFor(bill),
      });
      documents++;
    }
  }
  step(ctx, "bills", bills.length - created, created);
  ctx.log(`bill documents: ${documents} attached`);
}

const suggestionsPage = z.object({
  suggestions: rows(
    z.object({
      bill: z.object({ invoiceNumber: z.string().nullable() }),
      billId: id,
      transactionId: id,
      amount: z.number(),
      ambiguous: z.boolean(),
    }),
  ),
});

/** Matches every payment that carries its bill's reference; part payments are confirmed here because the server only suggests them. */
export async function matchBills(ctx: Context, bills: readonly BillSpec[]) {
  const ours = new Set(bills.map((b) => b.invoiceNumber));
  const result = await ctx.api.action("bills", "matchNow");
  const matched = z.object({ matched: z.number() }).parse(result.data).matched;
  let confirmed = 0;
  const page = await ctx.api.page("bills", suggestionsPage);
  for (const s of page.suggestions.filter(
    (s) => !s.ambiguous && ours.has(s.bill.invoiceNumber ?? ""),
  )) {
    await ctx.api.action("bills", "confirmSuggestion", {
      billId: s.billId,
      transactionId: s.transactionId,
      amount: plain(s.amount),
    });
    confirmed++;
  }
  const left = await ctx.api.page("bills", suggestionsPage);
  ctx.log(
    `bill matching: ${matched} matched, ${confirmed} part payments confirmed, ${left.suggestions.length} waiting`,
  );
}

// --- statements -----------------------------------------------------------------

const previewPage = z.object({
  counts: z.object({ new: z.number(), duplicate: z.number() }),
  errors: rows(z.string()),
  warnings: rows(z.string()),
  balanceWarnings: rows(z.unknown()),
});

const pendingPath = /^\/import\/([A-Za-z0-9_-]{32})$/;

async function importStatement(
  ctx: Context,
  accountId: string,
  fileName: string,
  xml: string,
) {
  const upload = await ctx.api.action("import", "upload", {
    accountId,
    file: {
      $file: {
        name: fileName,
        type: "application/xml",
        base64: Buffer.from(xml).toString("base64"),
      },
    },
  });
  const pending = pendingPath.exec(upload.redirect ?? "")?.[1];
  if (!pending) throw new Error(`${fileName}: the upload was not accepted`);
  let confirmed = false;
  try {
    const preview = await ctx.api.page(`import/${pending}`, previewPage);
    if (preview.errors.length > 0) {
      throw new Error(`${fileName}: ${preview.errors.join(" ")}`);
    }
    if (preview.counts.new === 0) return { added: 0, warnings: 0 };
    await ctx.api.action(`import/${pending}`, "confirm");
    confirmed = true;
    return {
      added: preview.counts.new,
      warnings: preview.warnings.length + preview.balanceWarnings.length,
    };
  } finally {
    if (!confirmed) await ctx.api.action(`import/${pending}`, "cancel");
  }
}

export async function seedStatements(
  ctx: Context,
  accounts: Map<AccountSpecKey, string>,
  ledger: Ledger,
) {
  const sources = [
    { key: "checking", entries: ledger.checking },
    { key: "savings", entries: ledger.savings },
    { key: "wallet", entries: ledger.wallet },
  ] as const;
  for (const source of sources) {
    const spec = ACCOUNTS.find((a) => a.key === source.key)!;
    const statements = quarterlyStatements(
      source.key,
      spec.iban!,
      "CHF",
      parseAmount(spec.openingBalance),
      source.entries,
      ctx.today,
    );
    let imported = 0;
    let rowsAdded = 0;
    let warnings = 0;
    for (const statement of statements) {
      const result = await importStatement(
        ctx,
        accounts.get(source.key)!,
        `${statement.id}.xml`,
        buildCamt053(statement),
      );
      if (result.added > 0) imported++;
      rowsAdded += result.added;
      warnings += result.warnings;
    }
    ctx.log(
      `statements ${source.key}: ${statements.length} files, ${imported} imported, ${rowsAdded} new transactions${warnings ? `, ${warnings} warnings` : ""}`,
    );
  }
}

// --- investments ----------------------------------------------------------------

const investmentsPage = z.object({
  securities: rows(z.object({ id, name: z.string() })),
  priceHistory: z
    .object({ prices: rows(z.object({ date: z.string() })) })
    .nullable(),
});

export async function seedInvesting(ctx: Context, brokerId: string) {
  const page = await ctx.api.page("investments", investmentsPage);
  const ids = new Map(page.securities.map((s) => [s.name, s.id]));
  let created = 0;
  for (const spec of SECURITIES) {
    if (ids.has(spec.name)) continue;
    const result = await ctx.api.action("investments", "createSecurity", {
      name: spec.name,
      kind: spec.kind,
      currency: spec.currency,
    });
    ids.set(spec.name, createdId(result, "security"));
    created++;
  }
  step(ctx, "securities", SECURITIES.length - created, created);

  const prices = buildPrices(ctx.today);
  let pricesAdded = 0;
  for (const spec of SECURITIES) {
    const securityId = ids.get(spec.name)!;
    const known = await ctx.api.page("investments", investmentsPage, {
      prices: securityId,
      all: "1",
    });
    const dates = new Set(known.priceHistory?.prices.map((p) => p.date));
    for (const price of prices.filter((p) => p.security === spec.name)) {
      if (dates.has(price.date)) continue;
      await ctx.api.action("investments", "setPrice", {
        securityId,
        date: price.date,
        price: plain(price.price),
      });
      pricesAdded++;
    }
  }
  step(ctx, "prices", prices.length - pricesAdded, pricesAdded);

  const account = await ctx.api.page(
    `accounts/${brokerId}`,
    z.object({
      trades: rows(
        z.object({ securityId: id, date: z.string(), side: z.string() }),
      ),
    }),
  );
  const trades = buildTrades(ctx.today);
  let tradesAdded = 0;
  for (const trade of trades) {
    const securityId = ids.get(trade.security)!;
    if (
      account.trades.some(
        (t) =>
          t.securityId === securityId &&
          t.date === trade.date &&
          t.side === "buy",
      )
    ) {
      continue;
    }
    await ctx.api.action(`accounts/${brokerId}`, "addTrade", {
      securityId,
      date: trade.date,
      side: "buy",
      quantity: tradeQuantity(trade.quantity),
      price: plain(trade.price),
      fees: plain(trade.fees),
      amount: plain(trade.amount),
    });
    tradesAdded++;
  }
  step(ctx, "trades", trades.length - tradesAdded, tradesAdded);
}

// --- pillar 3a ------------------------------------------------------------------

const pillarAccountPage = z.object({
  portfolios: rows(z.object({ id, name: z.string() })),
  portfolioValues: z.record(z.string(), rows(z.object({ date: z.string() }))),
});

const pillarPage = z.object({
  contributions: rows(
    z.object({
      source: z.string(),
      portfolioId: id,
      date: z.string(),
    }),
  ),
});

export async function seedPillar3a(ctx: Context, accountId: string) {
  const path = `accounts/${accountId}`;
  let account = await ctx.api.page(path, pillarAccountPage);
  let portfolio = account.portfolios.find((p) => p.name === PORTFOLIO.name);
  let created = 0;
  if (!portfolio) {
    const result = await ctx.api.action(path, "addPortfolio", {
      name: PORTFOLIO.name,
      number: PORTFOLIO.number,
      strategy: PORTFOLIO.strategy,
      depositReference: PORTFOLIO.depositReference,
      openedOn: PORTFOLIO.openedOn,
    });
    portfolio = { id: createdId(result, "portfolio"), name: PORTFOLIO.name };
    created++;
  }
  step(ctx, "portfolios", 1 - created, created);

  account = await ctx.api.page(path, pillarAccountPage);
  const known = new Set(
    (account.portfolioValues[portfolio.id] ?? []).map((v) => v.date),
  );
  const values = buildPortfolioValues(ctx.today);
  let added = 0;
  for (const value of values) {
    if (known.has(value.date)) continue;
    await ctx.api.action(path, "setPortfolioValues", {
      date: value.date,
      note: "",
      [`value:${portfolio.id}`]: plain(value.value),
      [`gain:${portfolio.id}`]: plain(value.gain),
      [`gainPercent:${portfolio.id}`]: plain(value.gainBps),
    });
    added++;
  }
  step(ctx, "portfolio values", values.length - added, added);

  const overview = await ctx.api.page("pillar-3a", pillarPage);
  const earlier = overview.contributions.some(
    (c) => c.source === "manual" && c.date === PILLAR_3A_OPENED,
  );
  if (!earlier) {
    await ctx.api.action("pillar-3a", "addContribution", {
      portfolioId: portfolio.id,
      date: PILLAR_3A_OPENED,
      kind: "ordinary",
      amount: plain(PILLAR_3A_CONTRIBUTION),
      gapYears: "",
      note: "",
    });
  }
  step(ctx, "contributions", earlier ? 1 : 0, earlier ? 0 : 1);
}

// --- taxes ----------------------------------------------------------------------

const taxYearPage = z.object({
  reconciliation: z.object({
    year: z.object({ id: z.string().nullable() }),
    rows: rows(
      z.object({
        office: z
          .object({ date: z.string(), reference: z.string().nullable() })
          .nullable(),
      }),
    ),
  }),
});

async function taxYear(ctx: Context, year: number) {
  try {
    return await ctx.api.page(`taxes/${year}`, taxYearPage);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function seedTaxes(ctx: Context, bills: readonly BillSpec[]) {
  let years = 0;
  for (const spec of TAX_YEARS) {
    if ((await taxYear(ctx, spec.year))?.reconciliation.year.id) continue;
    await ctx.api.action("taxes", "create", {
      year: String(spec.year),
      authority: spec.authority,
      currency: "CHF",
      assessedTotal: spec.assessedTotal,
      notes: spec.notes,
    });
    years++;
  }
  step(ctx, "tax years", TAX_YEARS.length - years, years);

  const credits = taxCredits(bills);
  let added = 0;
  for (const spec of TAX_YEARS) {
    const year = await taxYear(ctx, spec.year);
    const known = new Set(
      year?.reconciliation.rows.flatMap((r) =>
        r.office ? [`${r.office.date}|${r.office.reference}`] : [],
      ),
    );
    for (const credit of credits.filter((c) => c.year === spec.year)) {
      if (known.has(`${credit.bookingDate}|${credit.reference}`)) continue;
      await ctx.api.action(`taxes/${spec.year}`, "addCredit", {
        bookingDate: credit.bookingDate,
        amount: credit.amount,
        reference: credit.reference,
        description: credit.description,
      });
      added++;
    }
  }
  step(ctx, "tax credits", credits.length - added, added);
}

// --- forecast and recurring -------------------------------------------------------

const forecastPage = z.object({
  planned: rows(z.object({ id, label: z.string(), date: z.string() })),
  settings: rows(
    z.object({
      accountId: id,
      threshold: z.number().nullable(),
      defaultPayment: z.boolean(),
    }),
  ),
});

export async function seedForecast(ctx: Context, checkingId: string) {
  const page = await ctx.api.page("forecast", forecastPage);
  const specs = plannedItems(ctx.today);
  const labels = new Set(specs.map((s) => s.label));
  let removed = 0;
  for (const item of page.planned) {
    if (labels.has(item.label) && item.date < ctx.today) {
      await ctx.api.action("forecast", "deletePlanned", { id: item.id });
      removed++;
    }
  }
  let created = 0;
  for (const spec of specs) {
    if (
      page.planned.some((p) => p.label === spec.label && p.date >= ctx.today)
    ) {
      continue;
    }
    await ctx.api.action("forecast", "createPlanned", {
      label: spec.label,
      date: spec.date,
      direction: spec.direction,
      amount: spec.amount,
      accountId: checkingId,
    });
    created++;
  }
  step(ctx, "planned items", specs.length - created, created);
  if (removed > 0) ctx.log(`planned items: ${removed} past ones removed`);

  const threshold = parseAmount(FORECAST_SETTINGS.threshold);
  const current = page.settings.find((s) => s.accountId === checkingId);
  if (!current || current.threshold !== threshold || !current.defaultPayment) {
    await ctx.api.action("forecast", "saveSettings", {
      accountId: checkingId,
      threshold: FORECAST_SETTINGS.threshold,
      defaultPayment: "on",
    });
    ctx.log("forecast settings: saved");
  } else {
    ctx.log("forecast settings: present");
  }
}

const TRANSFER_PAYEES = ["Everyday account", "Example Pay"];

const recurringPage = z.object({
  series: rows(z.object({ id, name: z.string(), status: z.string() })),
});

export async function seedRecurring(ctx: Context) {
  const page = await ctx.api.page("recurring", recurringPage);
  let confirmed = 0;
  let dismissed = 0;
  for (const series of page.series.filter((s) => s.status === "suggested")) {
    const transfer = TRANSFER_PAYEES.includes(series.name);
    await ctx.api.action("recurring", transfer ? "dismiss" : "confirm", {
      id: series.id,
    });
    if (transfer) dismissed++;
    else confirmed++;
  }
  ctx.log(
    `recurring: ${page.series.length} detected, ${confirmed} newly confirmed, ${dismissed} transfers dismissed`,
  );
}

export async function seed(ctx: Context) {
  const ledger = buildLedger(ctx.today);
  const next = <T>(run: () => Promise<T>) => {
    if (ctx.stopped?.()) throw new Interrupted();
    return run();
  };
  const institutions = await next(() => seedInstitutions(ctx));
  const accounts = await next(() => seedAccounts(ctx, institutions));
  const categories = await next(() => seedCategories(ctx));
  await next(() => seedBudgets(ctx, categories));
  await next(() => seedBills(ctx, ledger.bills, accounts.get("checking")!));
  await next(() => seedStatements(ctx, accounts, ledger));
  await next(() => seedInvesting(ctx, accounts.get("broker")!));
  await next(() => seedPillar3a(ctx, accounts.get("pillar3a")!));
  await next(() => matchBills(ctx, ledger.bills));
  await next(() => seedTaxes(ctx, ledger.bills));
  await next(() => seedForecast(ctx, accounts.get("checking")!));
  await next(() => seedRecurring(ctx));
}
