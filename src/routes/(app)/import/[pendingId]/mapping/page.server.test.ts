import { useTestStore } from "$lib/testing/store";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { SIMPLE_CSV_PROFILE, uploadFixture } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { getCsvProfile } from "$lib/server/imports";
import { actions, load } from "./+page.server";

useTestDB();
useTestStore();

type User = Awaited<ReturnType<typeof createTestUser>>;

const loadAs = (user: User, pendingId: string) =>
  outcome(() =>
    load(createTestEvent({ user, params: { pendingId } }) as never),
  );
const save = (user: User, pendingId: string, form: Record<string, string>) =>
  outcome(() =>
    actions.save!(
      createTestEvent({ user, params: { pendingId }, form }) as never,
    ),
  );

async function setup() {
  const user = await createTestUser();
  const account = await seedAccount(user.id, { iban: EXAMPLE_IBAN });
  return { user, account };
}

describe("/import/[pendingId]/mapping", () => {
  it("load returns the mapping context with a guessed draft", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const r = await loadAs(user, id);
    expect(r.type).toBe("return");
    expect((r as { value: unknown }).value).toMatchObject({
      pendingId: id,
      format: "csv",
      account: { id: account.id },
      saved: false,
      errors: [],
      rowCount: 6,
      detected: expect.any(Array),
      sampleRows: expect.any(Array),
      preview: expect.any(Array),
      draft: expect.any(Object),
    });
  });

  it("camt uploads redirect to the preview", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    expect(await loadAs(user, id)).toEqual({
      type: "redirect",
      status: 303,
      location: `/import/${id}`,
    });
  });

  it("save stores the profile and redirects to the preview", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const r = await save(user, id, {
      name: "My mapping",
      profile: JSON.stringify(SIMPLE_CSV_PROFILE),
    });
    expect(r).toEqual({
      type: "redirect",
      status: 303,
      location: `/import/${id}`,
    });
    expect((await getCsvProfile(user.id, account.id))?.name).toBe("My mapping");
  });

  it("save fails with 400 for invalid JSON, invalid profile and blank name", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    expect(await save(user, id, { name: "x", profile: "{nope" })).toMatchObject(
      {
        type: "fail",
        status: 400,
        data: {
          action: "save",
          errors: { profile: [expect.any(String)] },
          values: { name: "x", profile: "{nope" },
        },
      },
    );
    expect(await save(user, id, { name: "x", profile: "{}" })).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { profile: [expect.any(String)] } },
    });
    expect(
      await save(user, id, {
        name: " ",
        profile: JSON.stringify(SIMPLE_CSV_PROFILE),
      }),
    ).toMatchObject({
      type: "fail",
      status: 400,
      data: { errors: { name: [expect.any(String)] } },
    });
    expect(await getCsvProfile(user.id, account.id)).toBeNull();
  });

  it("save reports a missing profile field under errors.profile", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    expect(await save(user, id, { name: "x" })).toMatchObject({
      type: "fail",
      status: 400,
      data: { action: "save", errors: { profile: [expect.any(String)] } },
    });
  });

  it("another user cannot load or save a mapping for my upload", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    expect(await loadAs(other, id)).toEqual({ type: "error", status: 404 });
    expect(
      await save(other, id, {
        name: "x",
        profile: JSON.stringify(SIMPLE_CSV_PROFILE),
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(await getCsvProfile(user.id, account.id)).toBeNull();
  });
});
