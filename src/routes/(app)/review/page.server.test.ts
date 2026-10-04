import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedAccount, seedImportedTransaction } from "$lib/testing/ledger";
import { load } from "./+page.server";

type Data = {
  year: number;
  firstYear: number;
  review: {
    year: number;
    currencies: { currency: string; expenses: number }[];
  };
};

async function run(
  user: Awaited<ReturnType<typeof createTestUser>>,
  query = "",
) {
  const r = await outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://localhost/review${query}`,
      }) as never,
    ),
  );
  return (r as { value: Data }).value;
}

describe("review page", () => {
  useTestDB();

  it("reviews the requested year for the current user only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    seedImportedTransaction(a.id, seedAccount(a.id).id, {
      amount: minor(-1000),
      bookingDate: "2024-03-10",
    });
    seedImportedTransaction(b.id, seedAccount(b.id).id, {
      amount: minor(-9999),
      bookingDate: "2024-03-10",
    });
    const v = await run(a, "?year=2024");
    expect(v.year).toBe(2024);
    expect(v.firstYear).toBe(2024);
    expect(v.review.currencies).toMatchObject([
      { currency: "CHF", expenses: 1000 },
    ]);
  });

  it("falls back to a default for an invalid or future year", async () => {
    const a = await createTestUser();
    const current = new Date().getFullYear();
    expect((await run(a, "?year=abc")).year).toBe(current);
    expect((await run(a, `?year=${current + 1}`)).year).toBe(current);
  });
});
