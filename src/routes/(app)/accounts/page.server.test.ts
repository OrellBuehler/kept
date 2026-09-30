import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { LEDGER_IBAN_A } from "$lib/testing/fixtures/ledger";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedInstitution } from "$lib/testing/ledger";
import { listAccounts } from "$lib/server/ledger/accounts";
import { listInstitutions } from "$lib/server/ledger/institutions";
import { actions, load } from "./+page.server";

type Form = Record<string, string>;
const run = (
  name: keyof typeof actions,
  user: Awaited<ReturnType<typeof createTestUser>>,
  form: Form,
) => outcome(() => actions[name]!(createTestEvent({ user, form }) as never));

describe("accounts page", () => {
  useTestDB();

  it("load returns institutions and accounts of the current user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const inst = seedInstitution(a.id, "Inst A");
    seedAccount(a.id, { institutionId: inst.id, iban: LEDGER_IBAN_A });
    seedInstitution(b.id, "Inst B");
    seedAccount(b.id, { name: "Bs account" });

    const r = await outcome(() => load(createTestEvent({ user: a }) as never));
    expect(r.type).toBe("return");
    const data = (
      r as { value: { institutions: unknown[]; accounts: unknown[] } }
    ).value;
    expect(data.institutions).toEqual([
      { id: inst.id, name: "Inst A", bic: null, color: null, accountCount: 1 },
    ]);
    expect(data.accounts).toEqual([
      expect.objectContaining({
        name: "Main",
        balance: 0,
        ibanMasked: "CH93 •••• 2957",
        archived: false,
        institution: { id: inst.id, name: "Inst A", color: null },
        lastBookingDate: null,
        lastImportAt: null,
      }),
    ]);
  });

  it("creates, updates and deletes an institution", async () => {
    const u = await createTestUser();
    const created = await run("createInstitution", u, {
      name: "Bank",
      bic: "aaaachzz",
      color: "#00FF00",
    });
    expect(created).toMatchObject({
      type: "return",
      value: { success: true, action: "createInstitution" },
    });
    const [inst] = listInstitutions(u.id);
    expect(inst).toMatchObject({
      name: "Bank",
      bic: "AAAACHZZ",
      color: "#00ff00",
    });

    expect(
      await run("updateInstitution", u, { id: inst!.id, name: "Bank 2" }),
    ).toMatchObject({ type: "return", value: { success: true } });
    expect(listInstitutions(u.id)[0]!.name).toBe("Bank 2");

    expect(await run("deleteInstitution", u, { id: inst!.id })).toMatchObject({
      type: "return",
      value: { success: true },
    });
    expect(listInstitutions(u.id)).toEqual([]);
  });

  it("returns field errors and echoes values", async () => {
    const u = await createTestUser();
    const r = await run("createInstitution", u, { name: "", bic: "x" });
    expect(r).toEqual({
      type: "fail",
      status: 400,
      data: {
        action: "createInstitution",
        errors: {
          name: ["Name is required."],
          bic: ["BIC must be 8 or 11 characters."],
        },
        values: { name: "", bic: "x", color: "" },
      },
    });
  });

  it("reports duplicate names and deletion of a used institution", async () => {
    const u = await createTestUser();
    const inst = seedInstitution(u.id, "Dup");
    seedAccount(u.id, { institutionId: inst.id });
    expect(await run("createInstitution", u, { name: "Dup" })).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: { name: ["An institution with this name already exists."] },
      },
    });
    expect(await run("deleteInstitution", u, { id: inst.id })).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: { form: [expect.stringContaining("still has accounts")] },
      },
    });
  });

  it("creates an account", async () => {
    const u = await createTestUser();
    const inst = seedInstitution(u.id);
    const r = await run("createAccount", u, {
      institutionId: inst.id,
      name: "Savings",
      type: "savings",
      currency: "chf",
      iban: "ch93 0076 2011 6238 5295 7",
      openingBalance: "1'000.50",
      openingDate: "2024-01-01",
    });
    expect(r).toMatchObject({
      type: "return",
      value: { success: true, action: "createAccount" },
    });
    expect(listAccounts(u.id)[0]).toMatchObject({
      name: "Savings",
      currency: "CHF",
      iban: LEDGER_IBAN_A,
      openingBalance: 100050,
      balance: 100050,
    });
  });

  it("validates account input and duplicate IBANs", async () => {
    const u = await createTestUser();
    const bad = await run("createAccount", u, {
      name: "x",
      type: "current",
      currency: "CHF",
      iban: "CH00",
    });
    expect(bad).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { iban: ["Enter a valid IBAN."] } },
    });
    seedAccount(u.id, { iban: LEDGER_IBAN_A });
    const dup = await run("createAccount", u, {
      name: "y",
      type: "current",
      currency: "CHF",
      iban: LEDGER_IBAN_A,
    });
    expect(dup).toMatchObject({
      type: "fail",
      data: { errors: { iban: ["Another account already uses this IBAN."] } },
    });
  });

  describe("cross-user", () => {
    it("user B cannot modify or delete user A's institutions", async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      const inst = seedInstitution(a.id, "Mine");

      expect(
        await run("updateInstitution", b, { id: inst.id, name: "Hijacked" }),
      ).toEqual({ type: "error", status: 404 });
      expect(await run("deleteInstitution", b, { id: inst.id })).toEqual({
        type: "error",
        status: 404,
      });
      expect(listInstitutions(a.id)[0]!.name).toBe("Mine");
    });

    it("user B cannot attach an account to user A's institution", async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      const inst = seedInstitution(a.id);
      const r = await run("createAccount", b, {
        institutionId: inst.id,
        name: "x",
        type: "current",
        currency: "CHF",
      });
      expect(r).toMatchObject({
        type: "fail",
        data: { errors: { institutionId: ["Unknown institution."] } },
      });
      expect(listAccounts(b.id)).toEqual([]);
    });

    it("load never includes another user's data", async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      seedInstitution(a.id);
      seedAccount(a.id);
      const r = await outcome(() =>
        load(createTestEvent({ user: b }) as never),
      );
      expect(r).toEqual({
        type: "return",
        value: { institutions: [], accounts: [] },
      });
    });
  });
});
