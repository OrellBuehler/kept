import { describe, expect, it } from "vitest";
import { getDB, csvProfiles } from "$lib/server/db";
import { archiveAccount } from "$lib/server/ledger/accounts";
import { fixture } from "$lib/testing/fixtures";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import {
  BAD_ROWS_PROFILE,
  SIMPLE_CSV_PROFILE,
  uploadBytes,
  uploadFixture,
  usePendingDir,
} from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { mappingContext } from "./mapping-context";
import { getCsvProfile, saveCsvProfile } from "./profiles";
import { startUpload } from "./upload";

useTestDB();
usePendingDir();

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
  return { user, account };
}

describe("csv profiles", () => {
  it("has none until saved, then upserts one per account", async () => {
    const { user, account } = await setup();
    expect(getCsvProfile(user.id, account.id)).toBeNull();
    saveCsvProfile(user.id, account.id, "First", SIMPLE_CSV_PROFILE);
    expect(getCsvProfile(user.id, account.id)).toMatchObject({
      name: "First",
      profile: { amountMode: "single", dateFormat: "YYYY-MM-DD" },
    });
    saveCsvProfile(user.id, account.id, "Second", {
      ...SIMPLE_CSV_PROFILE,
      dateFormat: "DD.MM.YYYY",
    });
    expect(getDB().select().from(csvProfiles).all()).toHaveLength(1);
    expect(getCsvProfile(user.id, account.id)).toMatchObject({
      name: "Second",
      profile: { dateFormat: "DD.MM.YYYY" },
    });
  });

  it("validates the profile and the name", async () => {
    const { user, account } = await setup();
    expect(() =>
      saveCsvProfile(user.id, account.id, "x", { amountMode: "single" }),
    ).toThrow(/columns/);
    expect(() =>
      saveCsvProfile(user.id, account.id, "  ", SIMPLE_CSV_PROFILE),
    ).toThrow(/Name/);
    expect(getCsvProfile(user.id, account.id)).toBeNull();
  });

  it("is scoped to the user", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    saveCsvProfile(user.id, account.id, "Mine", SIMPLE_CSV_PROFILE);
    expect(() => getCsvProfile(other.id, account.id)).toThrow(/not found/);
    expect(() =>
      saveCsvProfile(other.id, account.id, "Theirs", SIMPLE_CSV_PROFILE),
    ).toThrow(/not found/);
    expect(getCsvProfile(user.id, account.id)?.name).toBe("Mine");
  });

  it("treats a stored profile that no longer validates as missing", async () => {
    const { user, account } = await setup();
    saveCsvProfile(user.id, account.id, "Mine", SIMPLE_CSV_PROFILE);
    getDB().update(csvProfiles).set({ profile: '{"amountMode":"nope"}' }).run();
    expect(getCsvProfile(user.id, account.id)).toBeNull();
  });
});

describe("mappingContext", () => {
  it("offers a guessed draft, detected columns, sample rows and no errors for a fresh csv", async () => {
    const { user, account } = await setup();
    const id = uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const ctx = mappingContext(user.id, id);
    expect(ctx).toMatchObject({
      pendingId: id,
      format: "csv",
      saved: false,
      rowCount: 6,
      dataRowCount: 5,
      errors: [],
    });
    expect(ctx.detected.map((c) => c.name)).toEqual([
      "Date",
      "Counterparty",
      "Description",
      "Amount",
      "Currency",
    ]);
    expect(ctx.sampleRows[0]).toEqual([
      "Date",
      "Counterparty",
      "Description",
      "Amount",
      "Currency",
    ]);
    expect(ctx.draft).toMatchObject({
      dateFormat: "YYYY-MM-DD",
      columns: { bookingDate: "Date", amount: "Amount" },
    });
    expect(ctx.profile).not.toBeNull();
    expect(ctx.preview).toHaveLength(5);
    expect(ctx.preview.every((r) => r.transaction && !r.error)).toBe(true);
  });

  it("limits samples to 20 rows and the preview to 50", async () => {
    const { user, account } = await setup();
    const lines = ["Date,Counterparty,Description,Amount,Currency"];
    for (let i = 0; i < 80; i++) {
      lines.push(
        `2024-01-${String((i % 28) + 1).padStart(2, "0")},X,Row ${i},-1.00,CHF`,
      );
    }
    const id = uploadBytes(
      user.id,
      account.id,
      new TextEncoder().encode(lines.join("\n")),
      "big.csv",
    );
    const ctx = mappingContext(user.id, id, SIMPLE_CSV_PROFILE);
    expect(ctx.sampleRows).toHaveLength(20);
    expect(ctx.preview).toHaveLength(50);
    expect(ctx.rowCount).toBe(81);
    expect(ctx.dataRowCount).toBe(80);
  });

  it("counts data rows without preamble, blank lines and footer", async () => {
    const { user, account } = await setup();
    const id = uploadFixture(user.id, account.id, "csv/preamble-footer.csv");
    const ctx = mappingContext(user.id, id, {
      ...SIMPLE_CSV_PROFILE,
      headerRow: 5,
      skipFooterRows: 2,
      delimiter: ";",
      dateFormat: "DD.MM.YYYY",
      columns: { bookingDate: "Date", description: "Text", amount: "Amount" },
    });
    expect(ctx.dataRowCount).toBe(3);
  });

  it("previews a draft and reports row errors inline", async () => {
    const { user, account } = await setup();
    const id = uploadFixture(user.id, account.id, "csv/bad-rows.csv");
    const ctx = mappingContext(user.id, id, BAD_ROWS_PROFILE);
    expect(ctx.errors).toEqual([]);
    expect(ctx.profile).not.toBeNull();
    expect(ctx.preview.some((r) => r.error)).toBe(true);
  });

  it("reports an invalid draft and a missing column without throwing", async () => {
    const { user, account } = await setup();
    const id = uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const invalid = mappingContext(user.id, id, { amountMode: "single" });
    expect(invalid.profile).toBeNull();
    expect(invalid.preview).toEqual([]);
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(invalid.detected).toHaveLength(5);

    const missing = mappingContext(user.id, id, {
      ...SIMPLE_CSV_PROFILE,
      columns: { ...SIMPLE_CSV_PROFILE.columns, amount: "Nope" },
    });
    expect(missing.errors[0]).toMatch(/not found/);

    expect(mappingContext(user.id, id, 42).errors[0]).toMatch(/object/);
  });

  it("uses the saved profile when no draft is given", async () => {
    const { user, account } = await setup();
    saveCsvProfile(user.id, account.id, "Mine", SIMPLE_CSV_PROFILE);
    const id = uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const ctx = mappingContext(user.id, id);
    expect(ctx).toMatchObject({ saved: true, savedName: "Mine" });
    expect(ctx.profile?.columns.amount).toBe("Amount");
  });

  it("honours the draft's delimiter and encoding for raw rows", async () => {
    const { user, account } = await setup();
    const id = uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const ctx = mappingContext(user.id, id, {
      ...SIMPLE_CSV_PROFILE,
      delimiter: ";",
    });
    expect(ctx.sampleRows[0]).toHaveLength(1);
    expect(ctx.errors.length).toBeGreaterThan(0);
  });

  it("reads xlsx rows", async () => {
    const { user, account } = await setup();
    const id = uploadFixture(user.id, account.id, "xlsx/statement.xlsx");
    const ctx = mappingContext(user.id, id, SIMPLE_CSV_PROFILE);
    expect(ctx.format).toBe("xlsx");
    expect(ctx.rowCount).toBe(7);
    expect(ctx.detected[0]!.name).toBe("Date");
    expect(ctx.preview).toHaveLength(6);
  });

  it("refuses camt.053 uploads and other users' uploads", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const camt = uploadFixture(user.id, account.id, "camt053/v04-basic.xml");
    expect(() => mappingContext(user.id, camt)).toThrow(/no column mapping/);
    const csv = uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    expect(() => mappingContext(other.id, csv)).toThrow(/not found/);
  });
});

describe("startUpload", () => {
  const file = (name: string, bytes: Uint8Array) =>
    new File([new Uint8Array(bytes)], name);

  it("sends csv without a saved profile to the mapping page, camt and mapped csv straight on", async () => {
    const { user, account } = await setup();
    const csv = new TextEncoder().encode("a,b\n1,2\n");
    expect(
      (await startUpload(user.id, account.id, file("a.csv", csv))).needsMapping,
    ).toBe(true);
    const camt = fixture("camt053/v04-basic.xml");
    expect(
      (await startUpload(user.id, account.id, file("a.xml", camt)))
        .needsMapping,
    ).toBe(false);
    saveCsvProfile(user.id, account.id, "Mine", SIMPLE_CSV_PROFILE);
    expect(
      (await startUpload(user.id, account.id, file("a.csv", csv))).needsMapping,
    ).toBe(false);
  });

  it("rejects archived and foreign accounts", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const f = file("a.csv", new TextEncoder().encode("a,b\n1,2\n"));
    await expect(startUpload(other.id, account.id, f)).rejects.toThrow(
      /not found/,
    );
    const archived = seedAccount(user.id, { name: "Old", iban: null });
    archiveAccount(user.id, archived.id);
    await expect(startUpload(user.id, archived.id, f)).rejects.toThrow(
      /archived/,
    );
  });
});
