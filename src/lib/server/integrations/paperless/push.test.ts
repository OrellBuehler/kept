import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cancelBill, listBills, updateBill } from "$lib/server/bills/bills";
import {
  getDB,
  paperlessDocuments,
  type PaperlessFieldMapping,
} from "$lib/server/db";
import { clearEventListeners, onBillChanged } from "$lib/server/events";
import type { Minor } from "$lib/money";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { billInput, seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { EXAMPLE_SCOR } from "$lib/testing/fixtures/bill-identifiers";
import { useTestStore } from "$lib/testing/store";
import { startFakePaperless } from "./fake-server";
import {
  buildPushPlan,
  hashPlan,
  monetaryProblem,
  monetaryString,
  pushBill,
  pushBillSafely,
} from "./push";
import { getConnectionRow } from "./connection";
import { syncConnection } from "./sync";
import { billPdf, seedConnection } from "./testing";
import type { BillWithStatus } from "$lib/server/bills/status";

const fake = startFakePaperless();
afterAll(() => fake.stop());

describe("monetaryString", () => {
  it("formats minor units with integer math and two decimals", () => {
    expect(monetaryString(12345 as Minor, "CHF")).toBe("CHF123.45");
    expect(monetaryString(5 as Minor, "CHF")).toBe("CHF0.05");
    expect(monetaryString(100 as Minor, "EUR")).toBe("EUR1.00");
    expect(monetaryString(99_999_999_999 as Minor, "CHF")).toBe(
      "CHF999999999.99",
    );
  });

  it("matches the Paperless monetary pattern", () => {
    for (const n of [1, 9, 10, 99, 100, 101, 12345, 100000]) {
      expect(monetaryString(n as Minor, "CHF")).toMatch(
        /^[A-Z]{3}-?\d+(\.\d{1,2})$/,
      );
    }
  });

  it("tells unsupported currencies from non-positive amounts", () => {
    expect(monetaryProblem(500 as Minor, "JPY")).toBe("unsupported_currency");
    expect(monetaryProblem(0 as Minor, "CHF")).toBe("non_positive");
    expect(monetaryProblem(500 as Minor, "CHF")).toBeNull();
    const plan = (bill: Partial<BillWithStatus>) =>
      buildPushPlan(fakeBill(bill), { amount: 1 }).notes[0];
    expect(plan({ amount: 0 as Minor })).toContain("not positive");
    expect(plan({ currency: "JPY" })).toContain("JPY");
  });

  it("refuses currencies that do not have two decimals, bad codes and non-positive amounts", () => {
    expect(monetaryString(500 as Minor, "JPY")).toBeNull();
    expect(monetaryString(500 as Minor, "KWD")).toBeNull();
    expect(monetaryString(500 as Minor, "chf")).toBeNull();
    expect(monetaryString(500 as Minor, "ZZZZ")).toBeNull();
    expect(monetaryString(0 as Minor, "CHF")).toBeNull();
    expect(monetaryString(-5 as Minor, "CHF")).toBeNull();
  });
});

const fakeBill = (over: Partial<BillWithStatus> = {}) =>
  ({
    amount: 12345,
    currency: "CHF",
    dueDate: "2026-10-15",
    reference: EXAMPLE_SCOR,
    status: "open",
    ...over,
  }) as BillWithStatus;

describe("buildPushPlan", () => {
  const mapping: PaperlessFieldMapping = {
    amount: 1,
    dueDate: 2,
    reference: 3,
    status: 4,
  };

  it("builds values for every mapped field", () => {
    const plan = buildPushPlan(fakeBill(), mapping);
    expect(plan.values).toEqual({
      "1": "CHF123.45",
      "2": "2026-10-15",
      "3": EXAMPLE_SCOR,
      "4": "open",
    });
  });

  it("only includes mapped fields and fields that have a value", () => {
    expect(
      buildPushPlan(fakeBill({ dueDate: null, reference: null }), mapping)
        .values,
    ).toEqual({
      "1": "CHF123.45",
      "4": "open",
    });
    expect(buildPushPlan(fakeBill(), { dueDate: 2 }).values).toEqual({
      "2": "2026-10-15",
    });
  });

  it("maps statuses to configured values and skips unmapped ones when any are configured", () => {
    const m = { status: 4, statusValues: { open: "optA", paid: "optB" } };
    expect(buildPushPlan(fakeBill(), m).values).toEqual({ "4": "optA" });
    const plan = buildPushPlan(fakeBill({ status: "overpaid" }), m);
    expect(plan.values).toEqual({});
    expect(plan.notes[0]).toContain("overpaid");
  });

  it("notes foreign-exponent currencies and skips the amount", () => {
    const plan = buildPushPlan(fakeBill({ currency: "JPY" }), mapping);
    expect(plan.values["1"]).toBeUndefined();
    expect(plan.notes[0]).toContain("JPY");
  });

  it("hashes independent of key order and changes with values", () => {
    const a = hashPlan({ values: { "1": "x", "2": "y" }, notes: [] });
    const b = hashPlan({ values: { "2": "y", "1": "x" }, notes: [] });
    expect(a).toBe(b);
    expect(hashPlan({ values: { "1": "z", "2": "y" }, notes: [] })).not.toBe(a);
  });
});

describe("pushBill", () => {
  useTestDB();
  useTestStore();
  let user: TestUser;
  let pdf: Uint8Array;
  const mapping: PaperlessFieldMapping = {
    amount: 10,
    dueDate: 11,
    reference: 12,
    status: 13,
    statusValues: { open: "opt-open", cancelled: "opt-cancelled" },
  };

  beforeAll(async () => {
    pdf = await billPdf();
  }, 60_000);

  beforeEach(async () => {
    fake.requests = [];
    fake.docs.clear();
    fake.bulkStatus = 200;
    fake.token = "test-token";
    user = await createTestUser();
    seedConnection(user.id, fake, { mapping });
    fake.addDoc({ id: 7, original: pdf });
    await syncConnection(user.id);
  });
  afterEach(() => {
    clearEventListeners();
    vi.restoreAllMocks();
  });

  const bulkEdits = () => fake.requestsTo("/bulk_edit/", "POST");
  const billId = () => listBills(user.id)[0]!.id;
  const link = () =>
    getDB()
      .select()
      .from(paperlessDocuments)
      .where(
        and(
          eq(paperlessDocuments.userId, user.id),
          eq(paperlessDocuments.paperlessId, 7),
        ),
      )
      .get()!;

  it("pushes the mapped values as a merge (modify_custom_fields) when a bill is imported", () => {
    expect(bulkEdits()).toHaveLength(1);
    expect(bulkEdits()[0]!.json).toEqual({
      documents: [7],
      method: "modify_custom_fields",
      parameters: {
        add_custom_fields: {
          "10": "CHF1949.75",
          "11": "2024-04-14",
          "12": "210000000003139471430009017",
          "13": "opt-open",
        },
        remove_custom_fields: [],
      },
    });
    expect(fake.docs.get(7)!.custom_fields).toHaveLength(4);
    expect(link().lastPushedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves the modified time of its own write alone on the next sync", async () => {
    fake.requests = [];
    const r = await syncConnection(user.id);
    expect(r).toMatchObject({ unchanged: 1, updated: 0 });
    expect(fake.requestsTo("/download/")).toHaveLength(0);
  });

  it("skips the call when nothing changed", async () => {
    fake.requests = [];
    const r = await pushBill(user.id, billId());
    expect(r.status).toBe("unchanged");
    expect(fake.requests).toHaveLength(0);
  });

  it("pushes again after the bill changed", async () => {
    updateBill(
      user.id,
      billId(),
      billInput({
        creditorName: "Example Energy Ltd",
        dueDate: "2026-11-30",
        amount: 5 as Minor,
      }),
    );
    fake.requests = [];
    const r = await pushBill(user.id, billId());
    expect(r.status).toBe("pushed");
    expect(bulkEdits()[0]!.json).toMatchObject({
      parameters: {
        add_custom_fields: { "10": "CHF0.05", "11": "2026-11-30" },
      },
    });
  });

  it("follows bill events when the listener is registered", async () => {
    onBillChanged((u, b) => void pushBillSafely(u, b));
    fake.requests = [];
    cancelBill(user.id, billId());
    await vi.waitFor(() => expect(bulkEdits()).toHaveLength(1));
    expect(bulkEdits()[0]!.json).toMatchObject({
      parameters: { add_custom_fields: { "13": "opt-cancelled" } },
    });
  });

  it("does not write when Paperless says the user cannot change the document", async () => {
    fake.docs.get(7)!.user_can_change = false;
    updateBill(
      user.id,
      billId(),
      billInput({ creditorName: "Example Energy Ltd", dueDate: "2026-12-01" }),
    );
    fake.requests = [];
    const r = await pushBill(user.id, billId());
    expect(r).toMatchObject({ status: "skipped", reason: "read_only" });
    expect(bulkEdits()).toHaveLength(0);
  });

  it("remembers a read-only result instead of asking Paperless every time", async () => {
    fake.docs.get(7)!.user_can_change = false;
    updateBill(
      user.id,
      billId(),
      billInput({ creditorName: "Example Energy Ltd", dueDate: "2026-12-01" }),
    );
    expect(await pushBill(user.id, billId())).toMatchObject({
      reason: "read_only",
    });
    fake.requests = [];
    expect(await pushBill(user.id, billId())).toMatchObject({
      reason: "read_only",
    });
    expect(fake.requests).toHaveLength(0);

    // Values change: ask again. Document becomes writable: the push goes through.
    fake.docs.get(7)!.user_can_change = true;
    updateBill(
      user.id,
      billId(),
      billInput({ creditorName: "Example Energy Ltd", dueDate: "2026-12-05" }),
    );
    expect((await pushBill(user.id, billId())).status).toBe("pushed");
  });

  it("forgets the read-only marker when the document changes in Paperless", async () => {
    fake.docs.get(7)!.user_can_change = false;
    updateBill(
      user.id,
      billId(),
      billInput({ creditorName: "Example Energy Ltd", dueDate: "2026-12-01" }),
    );
    await pushBill(user.id, billId());
    expect(link().lastPushedHash).toMatch(/^ro:/);
    fake.docs.get(7)!.user_can_change = true;
    fake.docs.get(7)!.modified = "2026-10-01T10:00:00+00:00";
    await syncConnection(user.id);
    expect(link().lastPushedHash).toBeNull();
    expect((await pushBill(user.id, billId())).status).toBe("pushed");
  });

  it("skips bills without a link, without a mapping and on disabled connections", async () => {
    const id = billId();
    const unlinked = seedBill(user.id);
    expect(await pushBill(user.id, unlinked.id)).toMatchObject({
      reason: "not_linked",
    });

    const row = getConnectionRow(user.id)!;
    const { setFieldMapping, setEnabled } = await import("./connection");
    setFieldMapping(user.id, {});
    expect(await pushBill(user.id, id)).toMatchObject({
      reason: "no_mapping",
    });
    setFieldMapping(user.id, mapping);
    setEnabled(user.id, false);
    expect(await pushBill(user.id, id)).toMatchObject({
      reason: "disabled",
    });
    expect(row.id).toBeTruthy();
  });

  it("treats a document gone from Paperless as skipped", async () => {
    fake.docs.delete(7);
    updateBill(
      user.id,
      billId(),
      billInput({ creditorName: "Example Energy Ltd", dueDate: "2026-12-02" }),
    );
    expect(await pushBill(user.id, billId())).toMatchObject({ reason: "gone" });
  });

  it("the safe variant records failures by code and never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.bulkStatus = 403;
    updateBill(
      user.id,
      billId(),
      billInput({ creditorName: "Example Energy Ltd", dueDate: "2026-12-03" }),
    );
    const r = await pushBillSafely(user.id, billId());
    expect(r).toBeNull();
    expect(getConnectionRow(user.id)!.lastError).toBe("push_forbidden");
  });

  it("does not touch another user's documents", async () => {
    const other = await createTestUser();
    fake.requests = [];
    const theirs = seedBill(other.id);
    expect(await pushBill(other.id, theirs.id)).toMatchObject({
      reason: "not_linked",
    });
    expect(await pushBill(other.id, billId())).toMatchObject({
      reason: "not_linked",
    });
    expect(fake.requests.filter((r) => r.path.includes("/7/"))).toHaveLength(0);
  });
});
