import { useTestStore } from "$lib/testing/store";
import { describe, expect, it, vi } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { runAutoMatching } from "$lib/server/bills/suggestions";
import { listBillAllocations } from "$lib/server/bills/allocations";
import { billView } from "$lib/server/bills/status";
import { seedBill } from "$lib/testing/bills";
import {
  EXAMPLE_IBAN,
  EXAMPLE_IBAN_OTHER,
  EXAMPLE_QRR,
} from "$lib/testing/fixtures/bill-identifiers";
import { IBAN_QR } from "$lib/testing/fixtures/camt053/examples";
import { buildCamt } from "$lib/testing/fixtures/camt053/build";
import { uploadBytes, uploadFixture } from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { confirmImport, getPendingMeta } from "$lib/server/imports";
import { getDB, transactions } from "$lib/server/db";
import { actions, load } from "./+page.server";

vi.mock("$lib/server/bills/suggestions", async (orig) => {
  const actual = await orig<typeof import("$lib/server/bills/suggestions")>();
  return { ...actual, runAutoMatching: vi.fn(actual.runAutoMatching) };
});
const failMatching = () => {
  vi.mocked(runAutoMatching).mockImplementationOnce(() => {
    throw new Error("boom");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

useTestDB();
useTestStore();

type User = Awaited<ReturnType<typeof createTestUser>>;
interface Data {
  rows: { index: number; status: string }[];
  page: number;
  pageCount: number;
  pageSize: number;
  filter: string;
  filteredTotal: number;
  counts: {
    new: number;
    replacesMirror: number;
    duplicate: number;
    total: number;
  };
  canConfirm: boolean;
  needsMapping: boolean;
  errors: string[];
}

const loadAs = async (user: User, pendingId: string, query = "") => {
  const r = await outcome(() =>
    load(
      createTestEvent({
        user,
        params: { pendingId },
        url: `http://localhost/import/${pendingId}${query}`,
      }) as never,
    ),
  );
  return r;
};
const data = (r: Awaited<ReturnType<typeof loadAs>>) =>
  (r as { value: Data }).value;
const act = (name: "confirm" | "cancel", user: User, pendingId: string) =>
  outcome(() =>
    actions[name]!(
      createTestEvent({ user, params: { pendingId }, form: {} }) as never,
    ),
  );

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
  return { user, account };
}

function bigStatement(rows: number) {
  return buildCamt({
    iban: EXAMPLE_IBAN,
    entries: Array.from({ length: rows }, (_, i) => ({
      date: "2024-02-10",
      amount: "1.00",
      sign: "CRDT" as const,
      ref: `P${i}`,
    })),
  });
}

describe("/import/[pendingId] load", () => {
  it("returns the preview plus flags", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    const d = data(await loadAs(user, id));
    expect(d).toMatchObject({
      pendingId: id,
      format: "camt053",
      fileName: "overlap-a.xml",
      canConfirm: true,
      needsMapping: false,
      filter: "all",
      page: 1,
      pageCount: 1,
      pageSize: 100,
      filteredTotal: 5,
      counts: { new: 5, duplicate: 0, total: 5 },
    });
    expect(d.rows).toHaveLength(5);
  });

  it("flags mapping_required", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const d = data(await loadAs(user, id));
    expect(d).toMatchObject({
      needsMapping: true,
      canConfirm: false,
      errors: ["mapping_required"],
    });
  });

  it("paginates 100 rows per page and clamps out-of-range pages", async () => {
    const { user, account } = await setup();
    const id = await uploadBytes(user.id, account.id, bigStatement(250));
    const p1 = data(await loadAs(user, id));
    expect(p1).toMatchObject({ page: 1, pageCount: 3, filteredTotal: 250 });
    expect(p1.rows).toHaveLength(100);
    const p3 = data(await loadAs(user, id, "?page=3"));
    expect(p3.rows).toHaveLength(50);
    expect(p3.rows[0]!.index).toBe(201);
    expect(data(await loadAs(user, id, "?page=99")).page).toBe(3);
    expect(data(await loadAs(user, id, "?page=abc")).page).toBe(1);
  });

  it("filters new / duplicate rows, ignoring unknown filters", async () => {
    const { user, account } = await setup();
    await confirmImport(
      user.id,
      await uploadFixture(user.id, account.id, "camt053/overlap-a.xml"),
    );
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-b.xml",
    );
    const all = data(await loadAs(user, id));
    const news = data(await loadAs(user, id, "?filter=new"));
    const dups = data(await loadAs(user, id, "?filter=duplicate"));
    expect(all.filteredTotal).toBe(5);
    expect(news.rows.map((r) => r.status)).toEqual(["new", "new"]);
    expect(dups.rows.map((r) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    expect(dups.filteredTotal).toBe(3);
    expect(data(await loadAs(user, id, "?filter=zzz")).filter).toBe("all");
  });

  it("another user gets a 404", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    expect(await loadAs(other, id)).toEqual({ type: "error", status: 404 });
    expect(await loadAs(user, "../../etc/passwd")).toEqual({
      type: "error",
      status: 404,
    });
  });
});

describe("/import/[pendingId] actions", () => {
  it("confirm imports and redirects to the account with the import id", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    const r = await act("confirm", user, id);
    expect(r).toMatchObject({ type: "redirect", status: 303 });
    expect((r as { location: string }).location).toMatch(
      new RegExp(`^/accounts/${account.id}\\?imported=[0-9a-f-]{36}$`),
    );
    expect(getDB().select().from(transactions).all()).toHaveLength(5);
    expect(() => getPendingMeta(user.id, id)).toThrow();
  });

  it("confirm reports linked transfers in the redirect and the preview marks replacements", async () => {
    const { user, account } = await setup();
    const savings = seedAccount(user.id, {
      name: "Savings",
      iban: EXAMPLE_IBAN_OTHER,
      fillFromTransfers: true,
    });
    const entry = {
      date: "2024-03-10",
      amount: "10.00",
      ref: "T1",
    } as const;
    const out = await uploadBytes(
      user.id,
      account.id,
      buildCamt({
        iban: EXAMPLE_IBAN,
        entries: [
          { ...entry, sign: "DBIT", counterpartyIban: EXAMPLE_IBAN_OTHER },
        ],
      }),
    );
    const r = await act("confirm", user, out);
    expect((r as { location: string }).location).toMatch(
      new RegExp(
        `^/accounts/${account.id}\\?imported=[0-9a-f-]{36}&mirrored=1$`,
      ),
    );

    const incoming = await uploadBytes(
      user.id,
      savings.id,
      buildCamt({
        iban: EXAMPLE_IBAN_OTHER,
        entries: [{ ...entry, sign: "CRDT", counterpartyIban: EXAMPLE_IBAN }],
      }),
    );
    const preview = data(await loadAs(user, incoming));
    expect(preview.rows.map((row) => row.status)).toEqual(["replaces_mirror"]);
    expect(preview.counts.new).toBe(1);
    expect(preview.counts.replacesMirror).toBe(1);
    const newOnly = data(await loadAs(user, incoming, "?filter=new"));
    expect(newOnly.filteredTotal).toBe(0);
    const replacing = data(
      await loadAs(user, incoming, "?filter=replaces_mirror"),
    );
    expect(replacing.filteredTotal).toBe(1);
    const dupes = data(await loadAs(user, incoming, "?filter=duplicate"));
    expect(dupes.filteredTotal).toBe(0);
    const done = await act("confirm", user, incoming);
    expect((done as { location: string }).location).toMatch(
      new RegExp(`^/accounts/${savings.id}\\?imported=[0-9a-f-]{36}&linked=1$`),
    );
  });

  it("confirm auto-matches an open bill by its exact reference", async () => {
    const user = await createTestUser();
    const account = seedAccount(user.id, { iban: IBAN_QR });
    const bill = seedBill(user.id, {
      kind: "credit_note",
      amount: 1000 as never,
      reference: EXAMPLE_QRR,
      referenceType: "QRR",
    });
    expect(billView(user.id, bill.id, { today: "2026-10-01" }).status).toBe(
      "credit_due",
    );
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/qr-reference.xml",
    );
    const r = await act("confirm", user, id);
    expect(r).toMatchObject({ type: "redirect", status: 303 });
    expect(listBillAllocations(user.id, bill.id)).toHaveLength(1);
    expect(billView(user.id, bill.id, { today: "2026-10-01" }).status).toBe(
      "paid",
    );
  });

  it("a failing auto-match never fails the import", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    failMatching();
    const r = await act("confirm", user, id);
    expect(r).toMatchObject({ type: "redirect", status: 303 });
    expect(getDB().select().from(transactions).all()).toHaveLength(5);
  });

  it("confirm with blocking errors fails with 400 and imports nothing", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(user.id, account.id, "csv/overlap-a.csv");
    const r = await act("confirm", user, id);
    expect(r).toMatchObject({
      type: "fail",
      status: 400,
      data: {
        action: "confirm",
        errors: { form: [expect.stringMatching(/mapping_required/)] },
      },
    });
    expect(getDB().select().from(transactions).all()).toHaveLength(0);
  });

  it("confirm twice never duplicates", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    await act("confirm", user, id);
    expect(await act("confirm", user, id)).toEqual({
      type: "error",
      status: 404,
    });
    expect(getDB().select().from(transactions).all()).toHaveLength(5);
  });

  it("cancel deletes the upload and redirects to /import", async () => {
    const { user, account } = await setup();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    expect(await act("cancel", user, id)).toEqual({
      type: "redirect",
      status: 303,
      location: "/import",
    });
    expect(() => getPendingMeta(user.id, id)).toThrow();
  });

  it("another user cannot confirm or cancel my upload", async () => {
    const { user, account } = await setup();
    const other = await createTestUser();
    const id = await uploadFixture(
      user.id,
      account.id,
      "camt053/overlap-a.xml",
    );
    expect(await act("confirm", other, id)).toEqual({
      type: "error",
      status: 404,
    });
    expect(await act("cancel", other, id)).toEqual({
      type: "error",
      status: 404,
    });
    expect(getPendingMeta(user.id, id).id).toBe(id);
    expect(getDB().select().from(transactions).all()).toHaveLength(0);
  });
});
