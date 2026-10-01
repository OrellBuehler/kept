import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { addTaxCredit, setTransactionTaxYear } from "$lib/server/tax/tax";
import { taxCreditInputSchema } from "$lib/server/tax/schemas";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import * as list from "./+page.server";
import * as detail from "./[year]/+page.server";

type User = Awaited<ReturnType<typeof createTestUser>>;

const runList = (user: User, form: Record<string, string>) =>
  outcome(() => list.actions.create(createTestEvent({ user, form }) as never));
const loadDetail = (user: User, year: string) =>
  outcome(() =>
    detail.load(createTestEvent({ user, params: { year } }) as never),
  );
const runDetail = (
  name: keyof typeof detail.actions,
  user: User,
  year: string,
  form: Record<string, string> = {},
) =>
  outcome(() =>
    detail.actions[name]!(
      createTestEvent({ user, params: { year }, form }) as never,
    ),
  );

const yearForm = (over: Record<string, string> = {}) => ({
  year: "2025",
  authority: "Example Tax Office",
  currency: "CHF",
  assessedTotal: "3000.00",
  notes: "",
  ...over,
});

describe("taxes routes", () => {
  useTestDB();

  it("creates a year and redirects to it, rejecting bad input", async () => {
    const u = await createTestUser();
    const bad = await runList(u, yearForm({ year: "25" }));
    expect(bad).toMatchObject({ type: "fail", status: 400 });
    expect(bad.type === "fail" && bad.data).toMatchObject({
      errors: { year: expect.any(Array) },
    });

    const ok = await runList(u, yearForm());
    expect(ok).toMatchObject({ type: "redirect", location: "/taxes/2025" });

    const listed = await outcome(() =>
      list.load(createTestEvent({ user: u }) as never),
    );
    const years = (listed as { value: { years: { year: number }[] } }).value
      .years;
    expect(years.map((y) => y.year)).toEqual([2025]);
  });

  it("shows the reconciliation, adds and deletes statement lines", async () => {
    const u = await createTestUser();
    const account = seedAccount(u.id);
    const tx = seedImportedTransaction(u.id, account.id, {
      amount: minor(-100000),
      bookingDate: "2025-03-10",
    });
    await runList(u, yearForm());
    expect(
      await runDetail("tag", u, "2025", { transactionId: tx.id }),
    ).toMatchObject({ type: "return" });

    const bad = await runDetail("addCredit", u, "2025", {
      bookingDate: "2025-03-11",
      amount: "abc",
    });
    expect(bad).toMatchObject({ type: "fail", status: 400 });
    expect(
      await runDetail("addCredit", u, "2025", {
        bookingDate: "2025-03-11",
        amount: "1000.00",
        reference: "",
        description: "",
      }),
    ).toMatchObject({ type: "return" });

    const loaded = await loadDetail(u, "2025");
    const rec = (
      loaded as {
        value: {
          reconciliation: {
            reconciled: boolean;
            rows: { office: { id: string } | null }[];
          };
        };
      }
    ).value.reconciliation;
    expect(rec.reconciled).toBe(true);

    const creditId = rec.rows[0]!.office!.id;
    expect(
      await runDetail("deleteCredit", u, "2025", { creditId }),
    ).toMatchObject({ type: "return" });
    expect(
      await runDetail("untag", u, "2025", { transactionId: tx.id }),
    ).toMatchObject({
      type: "return",
    });
  });

  it("answers 404 for an unknown year or a malformed one", async () => {
    const u = await createTestUser();
    expect(await loadDetail(u, "2025")).toMatchObject({
      type: "error",
      status: 404,
    });
    expect(await loadDetail(u, "abcd")).toMatchObject({
      type: "error",
      status: 404,
    });
  });

  it("deletes a year's details and returns to the list", async () => {
    const u = await createTestUser();
    await runList(u, yearForm());
    expect(await runDetail("deleteYear", u, "2025")).toMatchObject({
      type: "redirect",
      location: "/taxes",
    });
  });

  it("keeps users apart", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const accountA = seedAccount(a.id);
    const tx = seedImportedTransaction(a.id, accountA.id, {
      amount: minor(-1000),
    });
    setTransactionTaxYear(a.id, tx.id, 2025);
    await runList(a, yearForm());
    const line = addTaxCredit(
      a.id,
      2025,
      taxCreditInputSchema("CHF").parse({
        bookingDate: "2025-03-11",
        amount: "10.00",
      }),
    );

    expect(await loadDetail(b, "2025")).toMatchObject({
      type: "error",
      status: 404,
    });
    expect(
      await runDetail("deleteCredit", b, "2025", { creditId: line.id }),
    ).toMatchObject({ type: "error", status: 404 });
    expect(
      await runDetail("tag", b, "2025", { transactionId: tx.id }),
    ).toMatchObject({ type: "error", status: 404 });
    expect(
      await runDetail("untag", b, "2025", { transactionId: tx.id }),
    ).toMatchObject({ type: "error", status: 404 });
    expect(await runDetail("deleteYear", b, "2025")).toMatchObject({
      type: "error",
      status: 404,
    });

    const stillThere = await loadDetail(a, "2025");
    expect(
      (stillThere as { value: { reconciliation: { balance: object } } }).value
        .reconciliation.balance,
    ).toMatchObject({ paidByMe: 1000, creditedByOffice: 1000 });
  });
});
