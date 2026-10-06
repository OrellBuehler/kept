import { useTestStore } from "$lib/testing/store";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { balanceSnapshots, getDB, imports, transactions } from "$lib/server/db";
import { currentBalance } from "$lib/server/ledger/balances";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { fixture } from "$lib/testing/fixtures";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { IBAN_DE } from "$lib/testing/fixtures/camt053/examples";
import { uploadBytes, uploadFixture } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { confirmImport } from "./confirm";
import { mappingContext } from "./mapping-context";
import { buildPreview } from "./preview";
import { startUpload } from "./upload";

useTestDB();
useTestStore();

async function setup(over: Parameters<typeof seedAccount>[1] = {}) {
  const user = await createTestUser();
  const account = await seedAccount(user.id, { iban: EXAMPLE_IBAN, ...over });
  return { user, account };
}

const rowsOf = async (accountId: string) =>
  await getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(asc(transactions.bookingDate), asc(transactions.externalId));

const snapshotsOf = async (accountId: string) =>
  await getDB()
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId));

describe("camt.054 import flow", () => {
  it("previews and confirms a notification; no balances are invented", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt054/overlap-a.xml",
    );
    const p = await buildPreview(user.id, id);
    expect(p.errors).toEqual([]);
    expect(p.format).toBe("camt054");
    expect(p.counts).toMatchObject({ new: 3, duplicate: 0, total: 3 });
    expect(p.statement).toMatchObject({
      accountIban: EXAMPLE_IBAN,
      currency: "CHF",
      openingBalance: null,
      closingBalance: null,
      fromDate: "2024-07-02",
      toDate: "2024-07-09",
    });
    expect(p.balanceWarnings).toEqual([]);

    const r = await confirmImport(user.id, id);
    expect(r).toMatchObject({ newCount: 3, duplicateCount: 0 });
    expect(await snapshotsOf(account.id)).toEqual([]);
    const [imp] = await getDB()
      .select()
      .from(imports)
      .where(eq(imports.accountId, account.id));
    expect(imp).toMatchObject({
      format: "camt054",
      openingBalance: null,
      closingBalance: null,
      newCount: 3,
    });
    expect((await rowsOf(account.id)).map((t) => t.amount)).toEqual([
      10000, -1200, -2000,
    ]);
    expect(await currentBalance(user.id, account.id, "2024-07-31")).toBe(
      minor(6800),
    );
  });

  it("imports overlapping notifications without duplicating bookings", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt054/overlap-a.xml"),
    );
    const idB = await uploadFixture(
      user.id,
      account.id,
      "camt054/overlap-b.xml",
    );
    const p = await buildPreview(user.id, idB);
    expect(p.rows.map((r) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "new",
    ]);
    expect(p.counts).toMatchObject({ new: 1, duplicate: 2 });
    expect(await confirmImport(user.id, idB)).toMatchObject({
      newCount: 1,
      duplicateCount: 2,
    });
    expect(await rowsOf(account.id)).toHaveLength(4);
  });

  it("recognises bookings that already arrived in a camt.053 statement", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt054/same-as-camt053.xml"),
    );
    expect(p.format).toBe("camt054");
    expect(p.rows.map((r) => [r.status, r.matchedBy])).toEqual([
      ["duplicate", "id"],
      ["duplicate", "id"],
    ]);
  });

  it("picks the notifications of this account from a multi-account file and merges them", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt054/multi-account.xml"),
    );
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => r.tx.amount)).toEqual([1000, -550]);
  });

  it("rejects a notification for another IBAN and a foreign currency", async () => {
    const { user, account } = await setup({ iban: IBAN_DE, currency: "CHF" });
    const other = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt054/v04-basic.xml"),
    );
    expect(other.errors.join(" ")).toMatch(/different IBAN/);
    const eur = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt054/v08-basic.xml"),
    );
    expect(eur.errors.join(" ")).toMatch(/file is in EUR/);
  });

  it("reports a malformed notification as a preview error", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        new TextEncoder().encode(
          `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.04"><BkToCstmrDbtCdtNtfctn><Ntfctn><Id>1</Id></Ntfctn></BkToCstmrDbtCdtNtfctn></Document>`,
        ),
      ),
    );
    expect(p.errors).toEqual([
      "Ntfctn #1 has no account identification (Acct/Id/IBAN or Othr/Id)",
    ]);
    expect(p.rows).toEqual([]);
  });

  it("needs no column mapping", async () => {
    const { user, account } = await setup();
    const { meta, needsMapping } = await startUpload(
      user.id,
      account.id,
      new File([new Uint8Array(fixture("camt054/v04-basic.xml"))], "n.xml"),
    );
    expect(meta.format).toBe("camt054");
    expect(needsMapping).toBe(false);
    await expect(mappingContext(user.id, meta.id)).rejects.toThrow(
      /need no column mapping/,
    );
  });
});

describe("MT940 import flow", () => {
  const eur = { iban: IBAN_DE, currency: "EUR" };

  it("previews and confirms a statement with balances", async () => {
    const { user, account } = await setup(eur);
    const id = await uploadFixture(user.id, account.id, "mt940/basic.sta");
    const p = await buildPreview(user.id, id);
    expect(p.errors).toEqual([]);
    expect(p.format).toBe("mt940");
    expect(p.counts).toMatchObject({ new: 4, duplicate: 0, total: 4 });
    expect(p.statement).toMatchObject({
      accountIban: IBAN_DE,
      currency: "EUR",
      fromDate: "2024-03-01",
      toDate: "2024-03-14",
      openingBalance: { amount: 100000, date: "2024-03-01" },
      closingBalance: { amount: 303050, date: "2024-03-15" },
    });
    expect(p.balanceWarnings).toEqual([]);

    const r = await confirmImport(user.id, id);
    expect(r).toMatchObject({ newCount: 4, duplicateCount: 0 });
    expect(
      (await snapshotsOf(account.id)).map((s) => [s.date, s.amount]),
    ).toEqual([["2024-03-15", 303050]]);
    const rows = await rowsOf(account.id);
    expect(rows.map((t) => t.amount)).toEqual([15000, -11950, 0, 200000]);
    expect(rows[0]).toMatchObject({
      source: "import",
      counterpartyName: "Jane Example",
      counterpartyIban: EXAMPLE_IBAN,
      description: "Refund order 77",
      externalId: "mt940:EXREF0001:2024-03-01:15000",
    });
    expect(await currentBalance(user.id, account.id, "2024-03-31")).toBe(
      minor(303050),
    );
    const [imp] = await getDB()
      .select()
      .from(imports)
      .where(eq(imports.accountId, account.id));
    expect(imp).toMatchObject({
      format: "mt940",
      openingBalance: 100000,
      openingBalanceDate: "2024-03-01",
      closingBalance: 303050,
      closingBalanceDate: "2024-03-15",
    });
  });

  it("imports overlapping files without duplicating bookings and keeps the ledger on the closing balance", async () => {
    const { user, account } = await setup(eur);
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "mt940/overlap-a.sta"),
    );
    const idB = await uploadFixture(user.id, account.id, "mt940/overlap-b.sta");
    const p = await buildPreview(user.id, idB);
    expect(p.rows.map((r) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "new",
    ]);
    // The second file's opening balance (end of 2024-07-02) agrees with the ledger.
    expect(p.balanceWarnings).toEqual([]);
    expect(await confirmImport(user.id, idB)).toMatchObject({
      newCount: 1,
      duplicateCount: 2,
    });
    expect(await rowsOf(account.id)).toHaveLength(4);
    expect(await currentBalance(user.id, account.id, "2024-07-31")).toBe(
      minor(126800),
    );
  });

  it("warns when the opening balance does not fit the ledger", async () => {
    const { user, account } = await setup(eur);
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "mt940/overlap-a.sta"),
    );
    const bytes = new TextEncoder().encode(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240710EUR999,00\n:61:240712C1,00NTRFNONREF//GAP1\n:62F:C240712EUR1000,00\n-\n`,
    );
    const p = await buildPreview(
      user.id,
      await uploadBytes(user.id, account.id, bytes, "gap.sta"),
    );
    expect(p.balanceWarnings.map((w) => w.code)).toEqual([
      "opening_mismatch",
      "closing_mismatch",
    ]);
    expect(p.balanceWarnings[0]).toMatchObject({
      code: "opening_mismatch",
      date: "2024-07-11",
      fileAmount: 99900,
      ledgerAmount: 106800,
    });
  });

  it("merges the pages of a multi-page statement and uses the last closing balance", async () => {
    const { user, account } = await setup(eur);
    const id = await uploadFixture(
      user.id,
      account.id,
      "mt940/multi-statement.sta",
    );
    const p = await buildPreview(user.id, id);
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => r.tx.amount)).toEqual([5000, -2500]);
    expect(p.statement).toMatchObject({
      openingBalance: { amount: 10000, date: "2024-01-02" },
      closingBalance: { amount: 12500, date: "2024-01-03" },
    });
    expect(p.balanceWarnings).toEqual([]);
  });

  it("takes the closing balance of the page later in the file when pages share a date", async () => {
    const { user, account } = await setup(eur);
    const bytes = new TextEncoder().encode(
      [
        `:20:P1\n:25:${IBAN_DE}\n:60F:C240101EUR100,00\n:61:240102C50,00NTRFNONREF//PG1\n:62M:C240102EUR150,00\n-`,
        `:20:P2\n:25:${IBAN_DE}\n:60M:C240102EUR150,00\n:61:240102D25,00NMSCNONREF//PG2\n:62F:C240102EUR125,00\n-\n`,
      ].join("\n"),
    );
    const p = await buildPreview(
      user.id,
      await uploadBytes(user.id, account.id, bytes, "pages.sta"),
    );
    expect(p.statement?.openingBalance?.amount).toBe(10000);
    expect(p.statement?.closingBalance?.amount).toBe(12500);
  });

  it("picks the statement of this account and rejects another IBAN", async () => {
    const { user, account } = await setup();
    const ch = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "mt940/multi-statement.sta"),
    );
    expect(ch.errors).toEqual([]);
    expect(ch.rows.map((r) => r.tx.amount)).toEqual([3000]);
    expect(ch.statement?.openingBalance?.amount).toBe(-1000);

    const mismatch = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "mt940/basic.sta"),
    );
    expect(mismatch.errors.join(" ")).toMatch(/different IBAN/);
  });

  it("imports a windows-1252 file with its umlauts intact", async () => {
    const { user, account } = await setup(eur);
    const id = await uploadFixture(user.id, account.id, "mt940/latin1.sta");
    await confirmImport(user.id, id);
    const [t] = await rowsOf(account.id);
    expect(t).toMatchObject({
      description: "Café Müller–Rechnung",
      counterpartyName: "Grüße & Söhne GmbH",
    });
  });

  it("imports a foreign-currency entry with its original amount", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "mt940/foreign.sta"),
    );
    const rows = await rowsOf(account.id);
    expect(
      rows.map((t) => [t.amount, t.originalAmount, t.originalCurrency]),
    ).toEqual([
      [-9235, -10000, "USD"],
      [50000, 52000, "EUR"],
      [-1000, null, null],
    ]);
  });

  it("previews an empty statement as a warning and writes only the balance", async () => {
    const { user, account } = await setup(eur);
    const id = await uploadFixture(user.id, account.id, "mt940/empty.sta");
    const p = await buildPreview(user.id, id);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toContain("The file contains no transactions.");
    await confirmImport(user.id, id);
    expect(await rowsOf(account.id)).toEqual([]);
    expect((await snapshotsOf(account.id)).map((s) => s.amount)).toEqual([
      4200,
    ]);
  });

  it("reports a malformed file as a preview error without a partial result", async () => {
    const { user, account } = await setup(eur);
    const bytes = new TextEncoder().encode(
      `:20:R\n:25:${IBAN_DE}\n:60F:C240101EUR1,00\n:61:240101C1,00NTRFNONREF//OK1\n:61:garbage\n:62F:C240101EUR2,00\n-\n`,
    );
    const p = await buildPreview(
      user.id,
      await uploadBytes(user.id, account.id, bytes, "bad.sta"),
    );
    expect(p.format).toBe("mt940");
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatch(/:61: \(line 5\): malformed entry field/);
    expect(p.rows).toEqual([]);
    expect(p.statement).toBeNull();
  });

  it("needs no column mapping", async () => {
    const { user, account } = await setup(eur);
    const { meta, needsMapping } = await startUpload(
      user.id,
      account.id,
      new File([new Uint8Array(fixture("mt940/basic.sta"))], "s.sta"),
    );
    expect(meta.format).toBe("mt940");
    expect(needsMapping).toBe(false);
  });
});
