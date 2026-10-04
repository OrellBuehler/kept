import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { seedPillar3aAccount, seedPortfolio } from "$lib/testing/pillar3a";
import { addManualContribution } from "$lib/server/pillar3a";
import { minor } from "$lib/money";
import { GET } from "./+server";

type User = Awaited<ReturnType<typeof createTestUser>>;

const get = (user: User | null, query: Record<string, string>) =>
  outcome(() =>
    GET(
      createTestEvent({
        user,
        url: `http://localhost/api/pillar-3a/buy-in-check?${new URLSearchParams(query)}`,
      }) as never,
    ),
  );
const body = async (r: Awaited<ReturnType<typeof get>>) =>
  (await (r as { value: Response }).value.json()) as {
    errors: string[];
    warnings: string[];
  };

describe("buy-in check endpoint", () => {
  useTestDB();

  it("requires a session", async () => {
    expect(
      await get(null, { date: "2026-03-01", amount: "100", gapYears: "2025" }),
    ).toMatchObject({ type: "error", status: 401 });
  });

  it("previews the rules for a buy-in", async () => {
    const u = await createTestUser();
    const ok = await get(u, {
      date: "2026-03-01",
      amount: "100",
      gapYears: "2025",
    });
    expect(ok).toMatchObject({ type: "return" });
    expect((await body(ok)).errors).toEqual([]);

    const tooEarly = await body(
      await get(u, { date: "2026-03-01", amount: "100", gapYears: "2024" }),
    );
    expect(tooEarly.errors.length).toBeGreaterThan(0);
  });

  it("reports a gap year already closed by another buy-in", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    const p = seedPortfolio(u.id, acc.id);
    addManualContribution(
      u.id,
      {
        portfolioId: p.id,
        date: "2026-03-01",
        amount: minor(10_000),
        kind: "buy_in",
        gapYears: [2025],
        note: null,
      },
      "2026-10-04",
    );
    const r = await body(
      await get(u, { date: "2026-04-01", amount: "100", gapYears: "2025" }),
    );
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("returns an empty result for an unparsable amount and 400 for a bad date", async () => {
    const u = await createTestUser();
    expect(
      await body(
        await get(u, { date: "2026-03-01", amount: "abc", gapYears: "" }),
      ),
    ).toEqual({ errors: [], warnings: [] });
    expect(
      await get(u, { date: "2026-03", amount: "1", gapYears: "" }),
    ).toMatchObject({ type: "error", status: 400 });
  });
});
