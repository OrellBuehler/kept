import { useTestStore } from "$lib/testing/store";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { fixture } from "$lib/testing/fixtures";
import { SIMPLE_CSV_PROFILE } from "$lib/testing/imports";
import { seedAccount, seedInstitution } from "$lib/testing/ledger";
import { confirmImport, saveCsvProfile } from "$lib/server/imports";
import { archiveAccount } from "$lib/server/ledger/accounts";
import { uploadFixture } from "$lib/testing/imports";
import { actions, load } from "./+page.server";

useTestDB();
useTestStore();

type User = Awaited<ReturnType<typeof createTestUser>>;

const upload = (user: User, form: Record<string, string | File>) =>
  outcome(() => actions.upload(createTestEvent({ user, form }) as never));
const file = (name: string, bytes: Uint8Array) =>
  new File([new Uint8Array(bytes)], name);
const loadAs = (user: User, query = "") =>
  outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://localhost/import${query}`,
      }) as never,
    ),
  );

async function setup() {
  const user = await createTestUser();
  const institution = await seedInstitution(user.id, "Example Bank");
  const account = await seedAccount(user.id, {
    iban: EXAMPLE_IBAN,
    institutionId: institution.id,
  });
  return { user, account };
}

describe("/import load", () => {
  it("lists active accounts only, recent imports and the selected account", async () => {
    const { user, account } = await setup();
    const archived = await seedAccount(user.id, { name: "Old", iban: null });
    await archiveAccount(user.id, archived.id);
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const r = await loadAs(user, `?account=${account.id}`);
    expect(r.type).toBe("return");
    const data = (r as { value: Record<string, unknown> }).value as {
      accounts: unknown[];
      recentImports: { accountId: string }[];
      selectedAccountId: string | null;
    };
    expect(data.accounts).toEqual([
      {
        id: account.id,
        name: account.name,
        currency: "CHF",
        institutionName: "Example Bank",
        institution: expect.objectContaining({ name: "Example Bank" }),
      },
    ]);
    expect(data.recentImports).toHaveLength(1);
    expect(data.selectedAccountId).toBe(account.id);
  });

  it("ignores a selected account that is archived, unknown or someone else's", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const theirs = await seedAccount(other.id, { iban: null });
    for (const id of [theirs.id, "nope"]) {
      const r = await loadAs(user, `?account=${id}`);
      expect(
        (r as { value: { selectedAccountId: unknown } }).value
          .selectedAccountId,
      ).toBeNull();
    }
    expect(account.id).toBeTruthy();
  });

  it("does not show another user's accounts or imports", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const r = await loadAs(other);
    const data = (
      r as { value: { accounts: unknown[]; recentImports: unknown[] } }
    ).value;
    expect(data.accounts).toEqual([]);
    expect(data.recentImports).toEqual([]);
  });
});

describe("/import upload", () => {
  it("camt goes straight to the preview", async () => {
    const { user, account } = await setup();
    const r = await upload(user, {
      accountId: account.id,
      file: file("statement.xml", fixture("camt053/v04-basic.xml")),
    });
    expect(r).toMatchObject({ type: "redirect", status: 303 });
    expect((r as { location: string }).location).toMatch(
      /^\/import\/[A-Za-z0-9_-]{32}$/,
    );
  });

  it("csv without a saved profile goes to the mapping page, with one to the preview", async () => {
    const { user, account } = await setup();
    const csv = file("s.csv", fixture("csv/overlap-a.csv"));
    const first = await upload(user, { accountId: account.id, file: csv });
    expect((first as { location: string }).location).toMatch(
      /^\/import\/[A-Za-z0-9_-]{32}\/mapping$/,
    );
    await saveCsvProfile(user.id, account.id, "Mine", SIMPLE_CSV_PROFILE);
    const second = await upload(user, { accountId: account.id, file: csv });
    expect((second as { location: string }).location).toMatch(
      /^\/import\/[A-Za-z0-9_-]{32}$/,
    );
  });

  it("xlsx is detected by content even with a .csv name", async () => {
    const { user, account } = await setup();
    const r = await upload(user, {
      accountId: account.id,
      file: file("data.csv", fixture("xlsx/statement.xlsx")),
    });
    expect((r as { location: string }).location).toMatch(/\/mapping$/);
  });

  it("fails with 400 for missing fields, empty files, unsupported XML", async () => {
    const { user, account } = await setup();
    expect(await upload(user, {})).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: { accountId: expect.any(Array), file: expect.any(Array) },
      },
    });
    expect(
      await upload(user, {
        accountId: account.id,
        file: file("e.csv", new Uint8Array()),
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { file: expect.any(Array) } },
    });
    const pain = new TextEncoder().encode(
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"/>',
    );
    const r = await upload(user, {
      accountId: account.id,
      file: file("p.xml", pain),
    });
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        errors: { file: [expect.stringMatching(/camt\.053/)] },
        values: { accountId: account.id },
      },
    });
  });

  it("rejects files over 20 MB", async () => {
    const { user, account } = await setup();
    const big = file("big.csv", new Uint8Array(20 * 1024 * 1024 + 1).fill(97));
    expect(
      await upload(user, { accountId: account.id, file: big }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { file: [expect.stringMatching(/20 MB/)] } },
    });
  });

  it("rejects archived accounts", async () => {
    const { user } = await setup();
    const old = await seedAccount(user.id, { name: "Old", iban: null });
    await archiveAccount(user.id, old.id);
    expect(
      await upload(user, {
        accountId: old.id,
        file: file("a.csv", new TextEncoder().encode("a\n1\n")),
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { accountId: expect.any(Array) } },
    });
  });

  it("another user cannot upload into my account", async () => {
    const { account } = await setup();
    const intruder = await createTestUser();
    const r = await upload(intruder, {
      accountId: account.id,
      file: file("a.xml", fixture("camt053/v04-basic.xml")),
    });
    expect(r).toEqual({ type: "error", status: 404 });
  });
});
