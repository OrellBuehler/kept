import { useTestStore } from "$lib/testing/store";
import { describe, expect, it } from "vitest";
import { maskIban } from "$lib/iban";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
} from "$lib/testing/fixtures/bill-identifiers";
import { buildCamt, buildCamtMulti } from "$lib/testing/fixtures/camt053/build";
import { IBAN_DE } from "$lib/testing/fixtures/camt053/examples";
import {
  BAD_ROWS_PROFILE,
  SIMPLE_CSV_PROFILE,
  uploadBytes,
  uploadFixture,
} from "$lib/testing/imports";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { parseMappingProfile } from "$lib/server/importers/mapping";
import { confirmImport } from "./confirm";
import { balanceWarningText, buildPreview } from "./preview";
import { saveCsvProfile } from "./profiles";

useTestDB();
useTestStore();

async function setup(over: Parameters<typeof seedAccount>[1] = {}) {
  const user = await createTestUser();
  const account = await seedAccount(user.id, { iban: EXAMPLE_IBAN, ...over });
  return { user, account };
}

const profile = parseMappingProfile(SIMPLE_CSV_PROFILE);

describe("buildPreview: camt.053", () => {
  it.each(["v04-basic", "v08-basic"])(
    "%s: every row is new on an empty account",
    async (name) => {
      const { user, account } = await setup(
        name === "v08-basic" ? { iban: IBAN_DE, currency: "EUR" } : {},
      );
      const p = await buildPreview(
        user.id,
        await uploadFixture(user.id, account.id, `camt053/${name}.xml`),
      );
      expect(p.errors).toEqual([]);
      expect(p.format).toBe("camt053");
      expect(p.account).toMatchObject({
        id: account.id,
        currency: account.currency,
      });
      expect(p.counts.new).toBe(p.rows.length);
      expect(p.counts).toMatchObject({ duplicate: 0, total: p.rows.length });
      expect(p.rows.every((r) => r.status === "new")).toBe(true);
      expect(p.rows.map((r) => r.index)).toEqual(p.rows.map((_, i) => i + 1));
      expect(p.statement?.closingBalance).not.toBeNull();
      expect(p.alreadyImportedAt).toBeNull();
    },
  );

  it("picks the statement of this account from a multi-account file (IBAN match wins)", async () => {
    const { user, account } = await setup({ iban: IBAN_DE, currency: "EUR" });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/multi-account.xml"),
    );
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.statement?.currency).toBe("EUR");
    expect(p.statement?.closingBalance?.amount).toBe(minor(47000));
    expect(p.rows).toHaveLength(1);
  });

  it("errors with masked IBANs when several statements and none match", async () => {
    const { user, account } = await setup({ iban: EXAMPLE_IBAN_OTHER });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/multi-account.xml"),
    );
    expect(p.statement).toBeNull();
    expect(p.rows).toEqual([]);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toContain(maskIban(EXAMPLE_IBAN));
    expect(p.errors[0]).toContain(maskIban(IBAN_DE));
    expect(p.errors[0]).not.toContain(EXAMPLE_IBAN);
    expect(p.errors[0]).not.toContain(IBAN_DE);
  });

  it("blocks a single statement for a different IBAN", async () => {
    const { user, account } = await setup({ iban: EXAMPLE_IBAN_OTHER });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toContain(maskIban(EXAMPLE_IBAN));
    expect(p.errors[0]).toContain(maskIban(EXAMPLE_IBAN_OTHER));
    expect(p.errors[0]).not.toContain(EXAMPLE_IBAN);
    await expect(
      confirmImport(
        user.id,
        await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
      ),
    ).rejects.toThrow(/different IBAN/);
  });

  it("merges several statements of the account, taking the latest closing balance whatever the order", async () => {
    const { user, account } = await setup();
    const id = await uploadBytes(
      user.id,
      account.id,
      buildCamtMulti([
        {
          iban: EXAMPLE_IBAN,
          opening: { amount: "150.00", date: "2024-04-01" },
          closing: { amount: "130.00", date: "2024-04-30" },
          entries: [
            { date: "2024-04-10", amount: "20.00", sign: "DBIT", ref: "M2" },
          ],
        },
        {
          iban: EXAMPLE_IBAN,
          opening: { amount: "100.00", date: "2024-03-01" },
          closing: { amount: "150.00", date: "2024-03-31" },
          entries: [
            { date: "2024-03-10", amount: "50.00", sign: "CRDT", ref: "M1" },
          ],
        },
      ]),
    );
    const p = await buildPreview(user.id, id);
    expect(p.errors).toEqual([]);
    expect(p.counts.total).toBe(2);
    expect(p.statement?.openingBalance).toMatchObject({
      date: "2024-03-01",
      amount: 10000,
    });
    expect(p.statement?.closingBalance).toMatchObject({
      date: "2024-04-30",
      amount: 13000,
    });
    expect(p.statement).toMatchObject({
      fromDate: "2024-03-10",
      toDate: "2024-04-10",
    });
  });

  it("warns when the account has no IBAN", async () => {
    const { user, account } = await setup({ iban: null });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    expect(p.errors).toEqual([]);
    expect(p.warnings[0]).toMatch(/no IBAN/);
  });

  it("blocks a statement in another currency than the account", async () => {
    const { user, account } = await setup({ iban: IBAN_DE, currency: "CHF" });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v08-basic.xml"),
    );
    expect(p.errors).toEqual([
      "The file is in EUR, but this account is in CHF.",
    ]);
  });

  it("keeps foreign-currency originals on CHF rows", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/foreign-currency.xml"),
    );
    expect(p.errors).toEqual([]);
    expect(p.rows.some((r) => r.tx.originalCurrency === "USD")).toBe(true);
  });

  it("falls back to the first and last booking date when the file declares no period", async () => {
    const { user, account } = await setup();
    const id = await uploadBytes(
      user.id,
      account.id,
      buildCamt({
        iban: EXAMPLE_IBAN,
        entries: [
          { date: "2024-05-20", amount: "5.00", sign: "CRDT", ref: "P2" },
          { date: "2024-05-03", amount: "9.00", sign: "DBIT", ref: "P1" },
        ],
      }),
    );
    const p = await buildPreview(user.id, id);
    expect(p.statement).toMatchObject({
      fromDate: "2024-05-03",
      toDate: "2024-05-20",
    });
  });

  it("keeps the declared period when the file has one", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    expect(p.statement).toMatchObject({
      fromDate: "2024-07-01",
      toDate: "2024-07-10",
    });
  });

  it("an empty statement has no rows but keeps its balances and warns", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/empty-statement.xml"),
    );
    expect(p.errors).toEqual([]);
    expect(p.counts).toEqual({
      new: 0,
      replacesMirror: 0,
      duplicate: 0,
      total: 0,
    });
    expect(p.statement?.closingBalance?.amount).toBe(minor(7500));
    expect(p.warnings).toContain("The file contains no transactions.");
  });

  it("rows without bank references still get distinct stable ids", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/no-refs.xml"),
    );
    expect(p.errors).toEqual([]);
    const ids = p.rows.map((r) => r.tx.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p.rows.every((r) => r.status === "new")).toBe(true);
  });

  it("reports malformed XML as an error, not an exception", async () => {
    const { user, account } = await setup();
    const id = await uploadBytes(
      user.id,
      account.id,
      new TextEncoder().encode(
        '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.04"><BkToCstmrStmt>',
      ),
    );
    const p = await buildPreview(user.id, id);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatch(/Invalid XML|camt\.053/);
    expect(p.rows).toEqual([]);
  });

  it("marks rows already in the ledger as duplicates", async () => {
    const { user, account } = await setup();
    const first = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    await seedImportedTransaction(user.id, account.id, {
      externalId: first.rows[0]!.tx.externalId,
      bookingDate: "2020-01-01",
    });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    expect(p.rows[0]!.status).toBe("duplicate");
    expect(p.counts).toEqual({
      new: first.rows.length - 1,
      replacesMirror: 0,
      duplicate: 1,
      total: first.rows.length,
    });
  });

  it("recognises rows imported with legacy NtryRef-based ids as duplicates", async () => {
    const { user, account } = await setup();
    for (const externalId of [
      "ntry:1:2024-07-02:-1200",
      "ntry:2:2024-07-03:-500",
      "ntry:3:2024-07-03:-500",
      "ntry:4:2024-07-05:8000",
      "ntry:5:2024-07-08:-1200",
    ]) {
      await seedImportedTransaction(user.id, account.id, { externalId });
    }
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-ntryref-a.xml"),
    );
    expect(p.counts).toEqual({
      new: 0,
      replacesMirror: 0,
      duplicate: 5,
      total: 5,
    });
    expect(p.rows.every((r) => r.matchedBy === "legacy_id")).toBe(true);
  });

  it("marks rows matched by their current id differently from legacy matches", async () => {
    const { user, account } = await setup();
    const pending = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-ntryref-a.xml",
    );
    const fresh = await buildPreview(user.id, pending);
    expect(fresh.rows.every((r) => r.matchedBy === null)).toBe(true);
    await seedImportedTransaction(user.id, account.id, {
      externalId: fresh.rows[0]!.tx.externalId,
    });
    await seedImportedTransaction(user.id, account.id, {
      externalId: fresh.rows[1]!.tx.legacyExternalIds![0]!,
    });
    const p = await buildPreview(user.id, pending);
    expect(p.rows.map((r) => r.matchedBy)).toEqual([
      "id",
      "legacy_id",
      null,
      null,
      null,
    ]);
  });
});

describe("buildPreview: csv and xlsx", () => {
  it("asks for a mapping when the account has no saved profile", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
    );
    expect(p.errors).toEqual(["mapping_required"]);
    expect(p.rows).toEqual([]);
    expect(p.statement).toBeNull();
  });

  it("parses with the profile argument", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
      { profile },
    );
    expect(p.errors).toEqual([]);
    expect(p.format).toBe("csv");
    expect(p.counts).toEqual({
      new: 5,
      replacesMirror: 0,
      duplicate: 0,
      total: 5,
    });
  });

  it("falls back to the account's saved profile", async () => {
    const { user, account } = await setup();
    await saveCsvProfile(user.id, account.id, "Mine", SIMPLE_CSV_PROFILE);
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
    );
    expect(p.errors).toEqual([]);
    expect(p.counts.total).toBe(5);
  });

  it("reads xlsx with a profile", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "xlsx/statement.xlsx"),
      { profile },
    );
    expect(p.errors).toEqual([]);
    expect(p.format).toBe("xlsx");
    expect(p.counts.total).toBe(6);
  });

  it("reports row errors with row numbers but without cell values", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/bad-rows.csv"),
      { profile: parseMappingProfile(BAD_ROWS_PROFILE) },
    );
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatch(
      /^3 rows could not be parsed \(row 3: .*row 4: /,
    );
    expect(p.errors[0]).not.toContain("12x");
    expect(p.rows).toEqual([]);
  });

  it("errors when the profile names a column the file lacks", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
      {
        profile: parseMappingProfile({
          ...SIMPLE_CSV_PROFILE,
          columns: { ...SIMPLE_CSV_PROFILE.columns, amount: "Nope" },
        }),
      },
    );
    expect(p.errors[0]).toMatch(/not found/);
  });

  it("blocks a csv in another currency than the account", async () => {
    const { user, account } = await setup({ currency: "EUR" });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
      { profile },
    );
    expect(p.errors).toEqual([
      "The file is in CHF, but this account is in EUR.",
    ]);
  });

  it("overlapping csv files: the second only adds the non-overlapping rows", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-a.csv"),
      { profile },
    );
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "csv/overlap-b.csv"),
      { profile },
    );
    expect(p.counts).toEqual({
      new: 1,
      replacesMirror: 0,
      duplicate: 4,
      total: 5,
    });
    expect(p.rows.filter((r) => r.status === "new")).toHaveLength(1);
    expect(p.warnings).toEqual([]);
  });
});

describe("buildPreview: continuity and repeats", () => {
  it("overlapping camt files: second adds only new rows and raises no warning", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-b.xml"),
    );
    expect(p.errors).toEqual([]);
    expect(p.counts).toEqual({
      new: 2,
      replacesMirror: 0,
      duplicate: 3,
      total: 5,
    });
    expect(p.warnings).toEqual([]);
  });

  it("a clean continuation raises no warning", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "100.00", date: "2024-03-01" },
          closing: { amount: "150.00", date: "2024-03-31" },
          entries: [
            { date: "2024-03-10", amount: "50.00", sign: "CRDT", ref: "C1" },
          ],
        }),
      ),
    );
    const p = await buildPreview(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "150.00", date: "2024-04-01" },
          closing: { amount: "130.00", date: "2024-04-30" },
          entries: [
            { date: "2024-04-10", amount: "20.00", sign: "DBIT", ref: "C2" },
          ],
        }),
      ),
    );
    expect(p.warnings).toEqual([]);
    expect(p.counts.new).toBe(1);
  });

  it("warns about a gap between imports, naming both amounts", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "100.00", date: "2024-03-01" },
          closing: { amount: "150.00", date: "2024-03-31" },
          entries: [
            { date: "2024-03-10", amount: "50.00", sign: "CRDT", ref: "G1" },
          ],
        }),
      ),
    );
    const p = await buildPreview(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "400.00", date: "2024-04-01" },
          closing: { amount: "380.00", date: "2024-04-30" },
          entries: [
            { date: "2024-04-10", amount: "20.00", sign: "DBIT", ref: "G2" },
          ],
        }),
      ),
    );
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.balanceWarnings).toHaveLength(2);
    expect(p.balanceWarnings[0]).toEqual({
      code: "opening_mismatch",
      date: "2024-04-01",
      fileAmount: minor(40000),
      ledgerAmount: minor(15000),
      currency: "CHF",
    });
    expect(balanceWarningText(p.balanceWarnings[0]!)).toContain(
      "gap between imports or missing transactions",
    );
  });

  it("warns when the closing balance disagrees with the ledger after the import", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "100.00", date: "2024-03-01" },
          closing: { amount: "150.00", date: "2024-03-31" },
          entries: [
            { date: "2024-03-10", amount: "50.00", sign: "CRDT", ref: "K1" },
          ],
        }),
      ),
    );
    const p = await buildPreview(
      user.id,
      await uploadBytes(
        user.id,
        account.id,
        buildCamt({
          iban: EXAMPLE_IBAN,
          opening: { amount: "150.00", date: "2024-04-01" },
          closing: { amount: "999.00", date: "2024-04-30" },
          entries: [
            { date: "2024-04-10", amount: "20.00", sign: "DBIT", ref: "K2" },
          ],
        }),
      ),
    );
    expect(p.balanceWarnings).toEqual([
      {
        code: "closing_mismatch",
        date: "2024-04-30",
        fileAmount: minor(99900),
        ledgerAmount: minor(13000),
        currency: "CHF",
      },
    ]);
  });

  it("the first import into an empty ledger has nothing to compare against", async () => {
    const { user, account } = await setup();
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    expect(p.warnings).toEqual([]);
  });

  it("reports alreadyImportedAt for the same file, not for a different one", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const same = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    expect(same.alreadyImportedAt).toBeGreaterThan(0);
    expect(same.errors).toEqual([]);
    expect(same.counts).toEqual({
      new: 0,
      replacesMirror: 0,
      duplicate: 5,
      total: 5,
    });
    const other = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-b.xml"),
    );
    expect(other.alreadyImportedAt).toBeNull();
  });
});

describe("buildPreview: isolation", () => {
  it("another user cannot preview a pending upload", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/v04-basic.xml",
    );
    await expect(buildPreview(other.id, id)).rejects.toThrow(/not found/);
  });

  it("duplicates are only detected against the same user's account", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, { iban: EXAMPLE_IBAN });
    const first = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    await seedImportedTransaction(other.id, theirs.id, {
      externalId: first.rows[0]!.tx.externalId,
    });
    const p = await buildPreview(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/v04-basic.xml"),
    );
    expect(p.counts.duplicate).toBe(0);
  });
});
