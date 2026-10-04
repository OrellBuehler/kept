import { describe, expect, it } from "vitest";
import { minor } from "$lib/money";
import { parseForm } from "$lib/server/forms";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_SCOR,
} from "$lib/testing/fixtures/bill-identifiers";
import { seedAccount } from "$lib/testing/ledger";
import {
  errorCode,
  makeQrr,
  seedPillar3aAccount,
  seedPortfolio,
} from "$lib/testing/pillar3a";
import { addManualContribution } from "./contributions";
import {
  closePortfolio,
  createPortfolio,
  deletePortfolio,
  getPortfolio,
  listPortfolios,
  reopenPortfolio,
  updatePortfolio,
} from "./portfolios";
import { portfolioCloseSchema, portfolioInputSchema } from "./schemas";
import { setValues } from "./values";

useTestDB();

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe("portfolioInputSchema", () => {
  it("normalizes the reference and blanks to null", () => {
    const qrr = makeQrr(42);
    const spaced = `${qrr.slice(0, 2)} ${qrr.slice(2, 7)} ${qrr.slice(7, 12)} ${qrr.slice(12, 17)} ${qrr.slice(17, 22)} ${qrr.slice(22)}`;
    expect(
      parseForm(
        portfolioInputSchema,
        form({ name: " Global ", depositReference: spaced, strategy: "" }),
      ),
    ).toMatchObject({
      ok: true,
      data: {
        name: "Global",
        depositReference: qrr,
        strategy: null,
        number: null,
        openedOn: null,
        sortOrder: null,
      },
    });
    expect(
      parseForm(
        portfolioInputSchema,
        form({ name: "A", depositReference: EXAMPLE_SCOR.toLowerCase() }),
      ),
    ).toMatchObject({ ok: true, data: { depositReference: EXAMPLE_SCOR } });
  });

  it("rejects a bad check digit, an empty name and a bad date", () => {
    const good = makeQrr(42);
    const bad = good.slice(0, -1) + String((Number(good.at(-1)) + 1) % 10);
    const r = parseForm(
      portfolioInputSchema,
      form({ name: "", depositReference: bad, openedOn: "2024-02-30" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual([
        "depositReference",
        "name",
        "openedOn",
      ]);
    }
  });

  it("validates the close form", () => {
    expect(
      parseForm(
        portfolioCloseSchema,
        form({ closedOn: "2030-01-31", closeReason: "wef" }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseForm(
        portfolioCloseSchema,
        form({ closedOn: "2030-01-31", closeReason: "bogus" }),
      ).ok,
    ).toBe(false);
  });
});

describe("portfolios", () => {
  it("creates, lists and updates portfolios of a 3a account", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    const a = seedPortfolio(u.id, acc.id, {
      name: "A",
      strategy: "Global 100",
      depositReference: makeQrr(1),
    });
    const b = seedPortfolio(u.id, acc.id, { name: "B" });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect(listPortfolios(u.id, acc.id).map((p) => p.name)).toEqual(["A", "B"]);
    const updated = updatePortfolio(u.id, a.id, {
      name: "A2",
      number: "N-1",
      strategy: null,
      depositReference: a.depositReference,
      openedOn: "2025-01-01",
      sortOrder: 5,
    });
    expect(updated).toMatchObject({
      name: "A2",
      number: "N-1",
      strategy: null,
      openedOn: "2025-01-01",
      sortOrder: 5,
      latestValue: null,
      latestValueDate: null,
    });
  });

  it("reports the latest value", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    const p = seedPortfolio(u.id, acc.id);
    setValues(u.id, acc.id, "2026-01-01", [
      { portfolioId: p.id, amount: minor(100) },
    ]);
    setValues(u.id, acc.id, "2026-03-01", [
      { portfolioId: p.id, amount: minor(150) },
    ]);
    expect(getPortfolio(u.id, p.id)).toMatchObject({
      latestValue: 150,
      latestValueDate: "2026-03-01",
    });
  });

  it("only allows portfolios on pillar 3a accounts", async () => {
    const u = await createTestUser();
    const acc = seedAccount(u.id);
    expect(errorCode(() => seedPortfolio(u.id, acc.id))).toBe("invalid:");
  });

  it("requires a QRR when the deposit IBAN is a QR-IBAN", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    expect(
      errorCode(() =>
        seedPortfolio(u.id, acc.id, { depositReference: EXAMPLE_SCOR }),
      ),
    ).toBe("invalid:depositReference");
    expect(
      errorCode(() =>
        seedPortfolio(u.id, acc.id, { depositReference: makeQrr(7) }),
      ),
    ).toBeUndefined();
    expect(
      errorCode(() => seedPortfolio(u.id, acc.id, { name: "No ref" })),
    ).toBeUndefined();
    const p = seedPortfolio(u.id, acc.id, {
      name: "C",
      depositReference: makeQrr(8),
    });
    expect(
      errorCode(() =>
        updatePortfolio(u.id, p.id, {
          name: "C",
          number: null,
          strategy: null,
          depositReference: EXAMPLE_SCOR,
          openedOn: null,
          sortOrder: null,
        }),
      ),
    ).toBe("invalid:depositReference");
  });

  it("requires a QR-IBAN for a QRR, but accepts either without a deposit IBAN", async () => {
    const u = await createTestUser();
    const plain = seedPillar3aAccount(u.id, {
      name: "P",
      depositIban: EXAMPLE_IBAN,
    });
    expect(
      errorCode(() =>
        seedPortfolio(u.id, plain.id, { depositReference: makeQrr(1) }),
      ),
    ).toBe("invalid:depositReference");
    expect(
      errorCode(() =>
        seedPortfolio(u.id, plain.id, { depositReference: EXAMPLE_SCOR }),
      ),
    ).toBeUndefined();
    const none = seedPillar3aAccount(u.id, { name: "N", depositIban: null });
    expect(
      errorCode(() =>
        seedPortfolio(u.id, none.id, { depositReference: makeQrr(2) }),
      ),
    ).toBeUndefined();
  });

  it("keeps the reference unique per user only", async () => {
    const u = await createTestUser();
    const other = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    const otherAcc = seedPillar3aAccount(other.id);
    const ref = makeQrr(5);
    const p = seedPortfolio(u.id, acc.id, { depositReference: ref });
    expect(
      errorCode(() =>
        seedPortfolio(u.id, acc.id, { name: "B", depositReference: ref }),
      ),
    ).toBe("conflict:depositReference");
    expect(
      errorCode(() =>
        seedPortfolio(other.id, otherAcc.id, { depositReference: ref }),
      ),
    ).toBeUndefined();
    expect(
      errorCode(() =>
        updatePortfolio(u.id, p.id, {
          name: "Same",
          number: null,
          strategy: null,
          depositReference: ref,
          openedOn: null,
          sortOrder: null,
        }),
      ),
    ).toBeUndefined();
  });

  it("closes, reopens and orders closed portfolios last", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    const a = seedPortfolio(u.id, acc.id, {
      name: "A",
      openedOn: "2025-01-01",
    });
    seedPortfolio(u.id, acc.id, { name: "B" });
    const closed = closePortfolio(u.id, a.id, {
      closedOn: "2030-06-30",
      closeReason: "age",
    });
    expect(closed).toMatchObject({
      closedOn: "2030-06-30",
      closeReason: "age",
    });
    expect(listPortfolios(u.id).map((p) => p.name)).toEqual(["B", "A"]);
    expect(
      errorCode(() =>
        closePortfolio(u.id, a.id, {
          closedOn: "2024-12-31",
          closeReason: "wef",
        }),
      ),
    ).toBe("invalid:closedOn");
    expect(reopenPortfolio(u.id, a.id)).toMatchObject({
      closedOn: null,
      closeReason: null,
    });
  });

  it("deletes only while there are no values or contributions", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    const withValue = seedPortfolio(u.id, acc.id, { name: "V" });
    const withContribution = seedPortfolio(u.id, acc.id, { name: "C" });
    const empty = seedPortfolio(u.id, acc.id, { name: "E" });
    setValues(u.id, acc.id, "2026-01-01", [
      { portfolioId: withValue.id, amount: minor(1) },
    ]);
    addManualContribution(
      u.id,
      {
        portfolioId: withContribution.id,
        date: "2026-02-01",
        amount: minor(1000),
        kind: "ordinary",
        gapYears: [],
        note: null,
      },
      "2026-06-01",
    );
    expect(errorCode(() => deletePortfolio(u.id, withValue.id))).toBe(
      "conflict:",
    );
    expect(errorCode(() => deletePortfolio(u.id, withContribution.id))).toBe(
      "conflict:",
    );
    deletePortfolio(u.id, empty.id);
    expect(listPortfolios(u.id).map((p) => p.name)).toEqual(["V", "C"]);
  });

  it("deleting the account removes its portfolios", async () => {
    const u = await createTestUser();
    const acc = seedPillar3aAccount(u.id);
    seedPortfolio(u.id, acc.id);
    const { deleteAccount } = await import("$lib/server/ledger");
    deleteAccount(u.id, acc.id);
    expect(listPortfolios(u.id)).toEqual([]);
  });

  it("hides other users' portfolios and accounts", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const acc = seedPillar3aAccount(owner.id);
    const p = seedPortfolio(owner.id, acc.id, { depositReference: makeQrr(9) });
    const input = {
      name: "x",
      number: null,
      strategy: null,
      depositReference: null,
      openedOn: null,
      sortOrder: null,
    };
    expect(listPortfolios(other.id)).toEqual([]);
    expect(errorCode(() => listPortfolios(other.id, acc.id))).toBe(
      "not_found:",
    );
    expect(errorCode(() => getPortfolio(other.id, p.id))).toBe("not_found:");
    expect(errorCode(() => createPortfolio(other.id, acc.id, input))).toBe(
      "not_found:",
    );
    expect(errorCode(() => updatePortfolio(other.id, p.id, input))).toBe(
      "not_found:",
    );
    expect(
      errorCode(() =>
        closePortfolio(other.id, p.id, {
          closedOn: "2030-01-01",
          closeReason: "age",
        }),
      ),
    ).toBe("not_found:");
    expect(errorCode(() => reopenPortfolio(other.id, p.id))).toBe("not_found:");
    expect(errorCode(() => deletePortfolio(other.id, p.id))).toBe("not_found:");
    expect(getPortfolio(owner.id, p.id).closedOn).toBeNull();
  });
});
