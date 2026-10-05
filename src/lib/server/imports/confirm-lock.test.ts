import { useTestStore } from "$lib/testing/store";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accounts, getDB, transactions, transfers } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_IBAN_THIRD,
} from "$lib/testing/fixtures/bill-identifiers";
import { buildCamt, type CamtEntry } from "$lib/testing/fixtures/camt053/build";
import { uploadBytes } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { confirmImport } from "./confirm";
import { undoImport } from "./history";
import { getPendingMeta } from "./pending";
import { buildPreview } from "./preview";

// Runs once between building a preview and writing it, where a concurrent change can land.
let afterPreview: (() => Promise<void>) | null = null;
vi.mock("./preview", async (orig) => {
  const actual = await orig<typeof import("./preview")>();
  return {
    ...actual,
    buildPreview: async (...args: Parameters<typeof actual.buildPreview>) => {
      const preview = await actual.buildPreview(...args);
      const hook = afterPreview;
      afterPreview = null;
      await hook?.();
      return preview;
    },
  };
});
afterEach(() => {
  afterPreview = null;
});

useTestDB();
useTestStore();

async function setup() {
  const user = await createTestUser();
  const a = await seedAccount(user.id, { name: "Main", iban: EXAMPLE_IBAN });
  const b = await seedAccount(user.id, {
    name: "Savings",
    type: "savings",
    iban: EXAMPLE_IBAN_OTHER,
    openingDate: "2024-01-01",
    fillFromTransfers: true,
  });
  return { user, a, b };
}

const outgoing = (): CamtEntry => ({
  date: "2024-03-10",
  amount: "100.00",
  sign: "DBIT",
  ref: "R1",
  counterpartyIban: EXAMPLE_IBAN_OTHER,
});
const incoming = (): CamtEntry => ({
  date: "2024-03-12",
  amount: "100.00",
  sign: "CRDT",
  ref: "R1",
  counterpartyIban: EXAMPLE_IBAN,
});
const statementA = () =>
  buildCamt({ iban: EXAMPLE_IBAN, entries: [outgoing()] });
const statementB = () =>
  buildCamt({ iban: EXAMPLE_IBAN_OTHER, entries: [incoming()] });

const rowsOf = async (accountId: string) =>
  await getDB()
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId));

describe("confirmImport re-checks the preview under the ledger lock", () => {
  it("takes over a mirror that appeared after the preview", async () => {
    const { user, a, b } = await setup();
    const pendingId = await uploadBytes(user.id, b.id, statementB());
    afterPreview = async () => {
      await confirmImport(
        user.id,
        await uploadBytes(user.id, a.id, statementA()),
      );
    };
    const result = await confirmImport(user.id, pendingId);
    expect(result.transfers).toMatchObject({ replaced: 1, mirrored: 0 });
    expect((await rowsOf(b.id)).map((r) => r.source)).toEqual(["import"]);
    expect(await getDB().select().from(transfers)).toHaveLength(1);
  });

  it("does not count a replacement whose mirror vanished after the preview", async () => {
    const { user, a, b } = await setup();
    const first = await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, statementA()),
    );
    expect((await rowsOf(b.id)).map((r) => r.source)).toEqual(["mirror"]);
    const pendingId = await uploadBytes(user.id, b.id, statementB());
    afterPreview = async () => {
      await undoImport(user.id, first.importId);
    };
    const result = await confirmImport(user.id, pendingId);
    expect(result.newCount).toBe(1);
    expect(result.transfers.replaced).toBe(0);
    expect((await rowsOf(b.id)).map((r) => r.source)).toEqual(["import"]);
  });

  it("refuses when the account currency changed after the preview", async () => {
    const { user, b } = await setup();
    const pendingId = await uploadBytes(user.id, b.id, statementB());
    afterPreview = async () => {
      await getDB()
        .update(accounts)
        .set({ currency: "EUR" })
        .where(eq(accounts.id, b.id));
    };
    await expect(confirmImport(user.id, pendingId)).rejects.toThrow(
      /changed since the preview/,
    );
    expect(await rowsOf(b.id)).toEqual([]);
    expect((await getPendingMeta(user.id, pendingId)).id).toBe(pendingId);
  });

  it("refuses to import into an account where trades move cash", async () => {
    const { user, b } = await setup();
    await getDB()
      .update(accounts)
      .set({ tradesMoveCash: true })
      .where(eq(accounts.id, b.id));
    const pendingId = await uploadBytes(user.id, b.id, statementB());
    const preview = await buildPreview(user.id, pendingId);
    expect(preview.errors.join(" ")).toMatch(/Trades move cash/);
    await expect(confirmImport(user.id, pendingId)).rejects.toThrow(
      /Trades move cash/,
    );
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("refuses when trades-move-cash was switched on after the preview", async () => {
    const { user, b } = await setup();
    const pendingId = await uploadBytes(user.id, b.id, statementB());
    afterPreview = async () => {
      await getDB()
        .update(accounts)
        .set({ tradesMoveCash: true })
        .where(eq(accounts.id, b.id));
    };
    await expect(confirmImport(user.id, pendingId)).rejects.toThrow(
      /Trades move cash/,
    );
    expect(await rowsOf(b.id)).toEqual([]);
  });

  it("does not take over another user's mirror", async () => {
    const { user, a, b } = await setup();
    await confirmImport(
      user.id,
      await uploadBytes(user.id, a.id, statementA()),
    );
    const other = await createTestUser();
    const c = await seedAccount(other.id, {
      name: "Theirs",
      iban: EXAMPLE_IBAN_THIRD,
      openingDate: "2024-01-01",
    });
    const result = await confirmImport(
      other.id,
      await uploadBytes(
        other.id,
        c.id,
        buildCamt({
          iban: EXAMPLE_IBAN_THIRD,
          entries: [{ ...incoming(), counterpartyIban: undefined }],
        }),
      ),
    );
    expect(result.transfers.replaced).toBe(0);
    expect((await rowsOf(b.id)).map((r) => r.source)).toEqual(["mirror"]);
  });
});
