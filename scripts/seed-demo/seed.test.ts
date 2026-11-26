import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ApiError, type ActionResult, type Fields } from "./client";
import { ACCOUNTS, INSTITUTIONS, TAX_YEARS } from "./dataset";
import { buildLedger } from "./ledger";
import {
  matchBills,
  seedAccounts,
  seedBills,
  seedForecast,
  seedInstitutions,
  seedRecurring,
  seedStatements,
  seedTaxes,
  Interrupted,
  seed,
  type Api,
  type Context,
} from "./seed";

interface Call {
  path: string;
  action: string;
  fields: Fields;
}

class Fake implements Api {
  pages = new Map<string, unknown>();
  calls: Call[] = [];
  results = new Map<string, (fields: Fields) => ActionResult>();
  lines: string[] = [];

  async page<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string> = {},
  ): Promise<z.output<S>> {
    const qs = new URLSearchParams(query).toString();
    const key = qs ? `${path}?${qs}` : path;
    if (!this.pages.has(key)) throw new ApiError(`no page ${key}`, 404);
    return schema.parse(this.pages.get(key));
  }

  async action(
    path: string,
    action: string,
    fields: Fields = {},
  ): Promise<ActionResult> {
    this.calls.push({ path, action, fields });
    const answer = this.results.get(`${path}#${action}`);
    return answer ? answer(fields) : { data: {}, redirect: null };
  }

  of(action: string) {
    return this.calls.filter((c) => c.action === action);
  }

  context(today = "2026-11-24"): Context {
    return { api: this, today, log: (line) => this.lines.push(line) };
  }
}

describe("institutions and accounts", () => {
  it("creates only the institutions that are missing", async () => {
    const fake = new Fake();
    fake.pages.set("accounts", {
      institutions: [{ id: "i-bank", name: "Example Bank" }],
      accounts: [],
    });
    let n = 0;
    fake.results.set("accounts#createInstitution", () => ({
      data: { id: `i-${++n}` },
      redirect: null,
    }));
    const ids = await seedInstitutions(fake.context());
    expect(fake.of("createInstitution").map((c) => c.fields.name)).toEqual(
      INSTITUTIONS.filter((i) => i.name !== "Example Bank").map((i) => i.name),
    );
    expect(fake.of("createInstitution")[0]!.fields).toMatchObject({
      websiteUrl: expect.stringMatching(/^https:\/\/example\.org\//),
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    });
    expect(ids.get("Example Bank")).toBe("i-bank");
    expect(ids.size).toBe(INSTITUTIONS.length);
    expect(fake.lines).toEqual(["institutions: 1 present, 2 created"]);
  });

  it("creates nothing when everything is there", async () => {
    const fake = new Fake();
    fake.pages.set("accounts", {
      institutions: INSTITUTIONS.map((i) => ({ id: i.name, name: i.name })),
      accounts: ACCOUNTS.map((a) => ({
        id: a.key,
        name: a.name,
        iban: a.iban,
        lastImportAt: null,
      })),
    });
    const institutions = await seedInstitutions(fake.context());
    const accounts = await seedAccounts(fake.context(), institutions);
    expect(fake.calls).toEqual([]);
    expect([...accounts.keys()]).toEqual(ACCOUNTS.map((a) => a.key));
  });

  it("opens each missing account with the settings its type needs", async () => {
    const fake = new Fake();
    fake.pages.set("accounts", {
      institutions: [],
      accounts: [
        {
          id: "a-checking",
          name: "Everyday account",
          iban: null,
          lastImportAt: null,
        },
      ],
    });
    fake.results.set("accounts#createAccount", (f) => ({
      data: { id: `a-${f.name}` },
      redirect: null,
    }));
    const institutions = new Map(
      INSTITUTIONS.map((i) => [i.name, `i-${i.name}`]),
    );
    const ids = await seedAccounts(fake.context(), institutions);
    const byName = new Map(
      fake.of("createAccount").map((c) => [c.fields.name, c.fields]),
    );
    expect(byName.has("Everyday account")).toBe(false);
    expect(ids.get("checking")).toBe("a-checking");
    expect(byName.get("Investment account")).toMatchObject({
      type: "investment",
      fillFromTransfers: "on",
      tradesMoveCash: "on",
    });
    expect(byName.get("Pillar 3a")).toMatchObject({
      type: "pillar_3a",
      iban: "",
      depositIbanField: "1",
      contractNumber: expect.any(String),
    });
    expect(byName.get("Rainy-day savings")).toMatchObject({
      noticeMonths: "3",
      freeWithdrawalPeriod: "year",
    });
    expect(byName.get("Prepaid card")).toMatchObject({
      openingBalance: "300.00",
    });
    for (const fields of byName.values()) {
      expect(fields.currency).toBe("CHF");
      expect(fields.openingDate).toBe("2026-01-01");
    }
  });
});

const billList = (
  items: {
    id: string;
    creditorName: string;
    invoiceNumber: string;
    documentId: string | null;
  }[],
  pageCount = 1,
) => ({
  list: { items, pageCount },
  suggestions: [],
});

describe("bills", () => {
  it("creates the missing ones and attaches a document where there is none", async () => {
    const { bills } = buildLedger("2026-11-24");
    const known = bills.slice(0, 3);
    const fake = new Fake();
    fake.pages.set(
      "bills?status=all",
      billList(
        known.map((b, i) => ({
          id: `b${i}`,
          creditorName: b.creditor,
          invoiceNumber: b.invoiceNumber,
          documentId: b.document ? null : "d",
        })),
        2,
      ),
    );
    fake.pages.set(
      "bills?status=all&page=2",
      billList(
        bills.slice(3, 5).map((b, i) => ({
          id: `c${i}`,
          creditorName: b.creditor,
          invoiceNumber: b.invoiceNumber,
          documentId: "d",
        })),
      ),
    );
    let n = 0;
    fake.results.set("bills/new#create", () => ({
      data: {},
      redirect: `/bills/new-${++n}`,
    }));
    await seedBills(fake.context(), bills, "a-checking");
    expect(fake.of("create")).toHaveLength(bills.length - 5);
    const first = fake.of("create")[0]!.fields;
    expect(first).toMatchObject({
      kind: "invoice",
      currency: "CHF",
      referenceType: "SCOR",
      expectedAccountId: "a-checking",
    });
    expect(first.amount).toMatch(/^\d+\.\d{2}$/);
    const attached = fake.of("attachDocument");
    expect(attached.length).toBeGreaterThan(0);
    for (const call of attached) {
      expect(call.fields.file).toMatchObject({
        $file: {
          type: "application/pdf",
          base64: expect.stringMatching(/^JVBER/),
        },
      });
    }
    expect(attached.filter((c) => c.path.startsWith("bills/b")).length).toBe(
      known.filter((b) => b.document).length,
    );
    expect(fake.lines[0]).toBe(`bills: 5 present, ${bills.length - 5} created`);
  });

  it("does nothing a second time", async () => {
    const { bills } = buildLedger("2026-11-24");
    const fake = new Fake();
    fake.pages.set(
      "bills?status=all",
      billList(
        bills.map((b, i) => ({
          id: `b${i}`,
          creditorName: b.creditor,
          invoiceNumber: b.invoiceNumber,
          documentId: "d",
        })),
      ),
    );
    await seedBills(fake.context(), bills, "a-checking");
    expect(fake.calls).toEqual([]);
  });

  it("does not take another creditor's invoice with the same number for its own", async () => {
    const { bills } = buildLedger("2026-11-24");
    const fake = new Fake();
    fake.pages.set(
      "bills?status=all",
      billList(
        bills.map((b, i) => ({
          id: `b${i}`,
          creditorName: i === 0 ? "Somebody else" : b.creditor,
          invoiceNumber: b.invoiceNumber,
          documentId: "d",
        })),
      ),
    );
    fake.results.set("bills/new#create", () => ({
      data: {},
      redirect: "/bills/new-1",
    }));
    await seedBills(fake.context(), bills, "a-checking");
    expect(fake.of("create").map((c) => c.fields.invoiceNumber)).toEqual([
      bills[0]!.invoiceNumber,
    ]);
  });

  it("confirms a part payment of its own bills, and nothing else", async () => {
    const fake = new Fake();
    const suggestion = (id: string, invoice: string, ambiguous: boolean) => ({
      bill: { invoiceNumber: invoice },
      billId: `bill-${id}`,
      transactionId: `tx-${id}`,
      amount: 60_000,
      ambiguous,
    });
    let asked = 0;
    fake.pages.set("bills", {
      get suggestions() {
        return asked++ === 0
          ? [
              suggestion("1", "GAR-2026-11", false),
              suggestion("2", "GAR-2026-11", true),
              suggestion("3", "SOMEONE-ELSES-1", false),
            ]
          : [suggestion("2", "GAR-2026-11", true), suggestion("3", "X", false)];
      },
    });
    fake.results.set("bills#matchNow", () => ({
      data: { matched: 2 },
      redirect: null,
    }));
    await matchBills(fake.context(), buildLedger("2026-11-24").bills);
    expect(fake.of("confirmSuggestion")).toEqual([
      {
        path: "bills",
        action: "confirmSuggestion",
        fields: { billId: "bill-1", transactionId: "tx-1", amount: "600.00" },
      },
    ]);
    expect(fake.lines).toEqual([
      "bill matching: 2 matched, 1 part payments confirmed, 2 waiting",
    ]);
  });
});

describe("statements", () => {
  const accounts = new Map([
    ["checking", "a1"],
    ["savings", "a2"],
    ["wallet", "a3"],
  ] as const) as never;
  const pending = "p".repeat(32);

  function importer(
    counts: { new: number; duplicate: number },
    errors: string[] = [],
  ) {
    const fake = new Fake();
    fake.results.set("import#upload", () => ({
      data: {},
      redirect: `/import/${pending}`,
    }));
    fake.pages.set(`import/${pending}`, {
      counts,
      errors,
      warnings: [],
      balanceWarnings: [],
    });
    return fake;
  }

  it("cancels files that hold nothing new", async () => {
    const fake = importer({ new: 0, duplicate: 50 });
    await seedStatements(fake.context(), accounts, buildLedger("2026-11-24"));
    expect(fake.of("upload")).toHaveLength(12);
    expect(fake.of("cancel")).toHaveLength(12);
    expect(fake.of("confirm")).toEqual([]);
    expect(fake.lines[0]).toBe(
      "statements checking: 4 files, 0 imported, 0 new transactions",
    );
  });

  it("confirms files with new bookings and uploads XML for the chosen account", async () => {
    const fake = importer({ new: 5, duplicate: 0 });
    await seedStatements(fake.context(), accounts, buildLedger("2026-11-24"));
    expect(fake.of("confirm")).toHaveLength(12);
    expect(fake.of("cancel")).toEqual([]);
    const first = fake.of("upload")[0]!.fields;
    expect(first.accountId).toBe("a1");
    const file = (first.file as { $file: { name: string; base64: string } })
      .$file;
    expect(file.name).toBe("checking-2026-q1.xml");
    expect(Buffer.from(file.base64, "base64").toString()).toContain("camt.053");
  });

  it("withdraws the upload when confirming it fails", async () => {
    const fake = importer({ new: 5, duplicate: 0 });
    fake.results.set(`import/${pending}#confirm`, () => {
      throw new ApiError("POST confirm failed (409)", 409);
    });
    await expect(
      seedStatements(fake.context(), accounts, buildLedger("2026-11-24")),
    ).rejects.toThrow(/409/);
    expect(fake.of("cancel")).toHaveLength(1);
  });

  it("stops on a preview with errors, after withdrawing the upload", async () => {
    const fake = importer({ new: 0, duplicate: 0 }, [
      "The statement is for a different IBAN.",
    ]);
    await expect(
      seedStatements(fake.context(), accounts, buildLedger("2026-11-24")),
    ).rejects.toThrow(/different IBAN/);
    expect(fake.of("cancel")).toHaveLength(1);
    expect(fake.of("confirm")).toEqual([]);
  });
});

describe("forecast", () => {
  const page = (
    planned: { id: string; label: string; date: string }[],
    settings: unknown[] = [],
  ) => ({
    planned,
    settings,
  });

  it("plans the months ahead once and keeps what is already ahead", async () => {
    const fake = new Fake();
    fake.pages.set(
      "forecast",
      page(
        [{ id: "p1", label: "Holiday deposit", date: "2026-12-03" }],
        [{ accountId: "a1", threshold: 100_000, defaultPayment: true }],
      ),
    );
    await seedForecast(fake.context(), "a1");
    expect(fake.of("createPlanned").map((c) => c.fields.label)).toEqual([
      "Car insurance renewal",
      "Expected tax refund",
    ]);
    expect(fake.of("deletePlanned")).toEqual([]);
    expect(fake.of("saveSettings")).toEqual([]);
    expect(fake.lines).toEqual([
      "planned items: 1 present, 2 created",
      "forecast settings: present",
    ]);
  });

  it("replaces its own planned items once their day has passed, and nothing else", async () => {
    const fake = new Fake();
    fake.pages.set(
      "forecast",
      page([
        { id: "old", label: "Holiday deposit", date: "2026-12-03" },
        { id: "mine", label: "Something I added", date: "2026-11-01" },
        { id: "ahead", label: "Expected tax refund", date: "2027-01-20" },
      ]),
    );
    await seedForecast(fake.context("2026-12-24"), "a1");
    expect(fake.of("deletePlanned").map((c) => c.fields.id)).toEqual(["old"]);
    expect(
      fake.of("createPlanned").map((c) => [c.fields.label, c.fields.date]),
    ).toEqual([
      ["Holiday deposit", "2027-01-03"],
      ["Car insurance renewal", "2027-01-15"],
    ]);
    expect(fake.of("saveSettings")).toHaveLength(1);
  });
});

describe("recurring payments", () => {
  it("confirms what it detected, dismisses transfers, and leaves decisions alone", async () => {
    const fake = new Fake();
    fake.pages.set("recurring", {
      series: [
        { id: "s1", name: "Example Property Management", status: "suggested" },
        { id: "s2", name: "Everyday account", status: "suggested" },
        { id: "s3", name: "Example Pay", status: "suggested" },
        { id: "s4", name: "Example Fitness", status: "dismissed" },
        { id: "s5", name: "Example Rail", status: "confirmed" },
      ],
    });
    await seedRecurring(fake.context());
    expect(fake.calls.map((c) => [c.action, c.fields.id])).toEqual([
      ["confirm", "s1"],
      ["dismiss", "s2"],
      ["dismiss", "s3"],
    ]);
  });
});

describe("taxes", () => {
  const rows = (office: { date: string; reference: string | null }[]) => ({
    reconciliation: {
      year: { id: "t" },
      rows: office.map((o) => ({ office: o })),
    },
  });

  it("creates years that have no row yet, also when only bills mention them", async () => {
    const { bills } = buildLedger("2026-11-24");
    const fake = new Fake();
    fake.pages.set("taxes/2025", {
      reconciliation: { year: { id: null }, rows: [] },
    });
    fake.pages.set("taxes/2026", rows([]));
    await seedTaxes(fake.context(), bills);
    expect(fake.of("create").map((c) => c.fields.year)).toEqual(["2025"]);
    expect(fake.of("create")[0]!.fields).toMatchObject({
      authority: TAX_YEARS[0]!.authority,
      assessedTotal: "",
    });
    expect(fake.of("addCredit")).toHaveLength(4);
  });

  it("creates a year the server does not know at all, and skips known credits", async () => {
    const { bills } = buildLedger("2026-11-24");
    const fake = new Fake();
    const known = bills.find((b) => b.invoiceNumber === "TAX-2026-1")!;
    fake.pages.set(
      "taxes/2026",
      rows([{ date: "2026-03-21", reference: known.reference }]),
    );
    await seedTaxes(fake.context(), bills);
    expect(fake.of("create").map((c) => c.fields.year)).toEqual(["2025"]);
    const credited = fake
      .of("addCredit")
      .filter((c) => c.path === "taxes/2026");
    expect(credited).toHaveLength(2);
    expect(credited.map((c) => c.fields.reference)).not.toContain(
      known.reference,
    );
  });

  it("rethrows errors other than a missing year", async () => {
    const fake = new Fake();
    fake.page = async () => {
      throw new ApiError("GET failed (500)", 500);
    };
    await expect(seedTaxes(fake.context(), [])).rejects.toThrow(/500/);
  });
});

describe("seed", () => {
  it("stops before the next step once asked to", async () => {
    const fake = new Fake();
    fake.pages.set("accounts", { institutions: [], accounts: [] });
    fake.results.set("accounts#createInstitution", (f) => ({
      data: { id: String(f.name) },
      redirect: null,
    }));
    let calls = 0;
    const ctx = fake.context();
    ctx.stopped = () => ++calls > 1;
    await expect(seed(ctx)).rejects.toBeInstanceOf(Interrupted);
    expect(fake.of("createInstitution")).toHaveLength(INSTITUTIONS.length);
    expect(fake.of("createAccount")).toEqual([]);
  });
});
