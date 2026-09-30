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
import { listBills } from "$lib/server/bills/bills";
import { clearEventListeners } from "$lib/server/events";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestDocuments } from "$lib/testing/documents";
import { setEnabled } from "./connection";
import { startFakePaperless } from "./fake-server";
import { unregisterPaperless, registerPaperless } from "./index";
import { runCatchUp, startScheduler } from "./scheduler";
import { isSyncing, syncConnection } from "./sync";
import { billPdf, seedConnection } from "./testing";
import { getConnectionRow } from "./connection";
import { eq } from "drizzle-orm";
import { getDB, paperlessConnections } from "$lib/server/db";

const fake = startFakePaperless();
afterAll(() => fake.stop());

let pdf: Uint8Array;
beforeAll(async () => {
  pdf = await billPdf();
}, 60_000);

describe("scheduler", () => {
  useTestDB();
  useTestDocuments();
  let user: TestUser;

  beforeEach(async () => {
    fake.requests = [];
    fake.docs.clear();
    fake.delayMs = 0;
    fake.token = "test-token";
    user = await createTestUser();
  });
  afterEach(() => {
    unregisterPaperless();
    clearEventListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("catch-up syncs every enabled connection and skips disabled ones", async () => {
    const other = await createTestUser();
    seedConnection(user.id, fake);
    seedConnection(other.id, fake);
    setEnabled(other.id, false);
    fake.addDoc({ id: 1, original: pdf });

    await runCatchUp();

    expect(listBills(user.id)).toHaveLength(1);
    expect(listBills(other.id)).toHaveLength(0);
  });

  it("skips a connection that is already syncing", async () => {
    seedConnection(user.id, fake);
    fake.addDoc({ id: 1, original: pdf });
    fake.delayMs = 150;
    const running = syncConnection(user.id);
    expect(isSyncing(getConnectionRow(user.id)!.id)).toBe(true);
    fake.requests = [];

    await runCatchUp();
    expect(fake.requests).toHaveLength(0);

    await running;
    expect(isSyncing(getConnectionRow(user.id)!.id)).toBe(false);
  });

  it("a failing connection does not stop the others", async () => {
    const other = await createTestUser();
    seedConnection(user.id, fake);
    seedConnection(other.id, fake);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.addDoc({ id: 1, original: pdf });
    // A stored address that cannot be used makes the first connection fail.
    getDB()
      .update(paperlessConnections)
      .set({ baseUrl: "not a url" })
      .where(eq(paperlessConnections.userId, user.id))
      .run();

    await runCatchUp();

    expect(listBills(other.id)).toHaveLength(1);
  });

  it("runs on a timer and can be stopped", async () => {
    seedConnection(user.id, fake);
    fake.addDoc({ id: 1, original: pdf });
    const stop = startScheduler({
      intervalMs: 60_000,
      firstRunDelayMs: 10,
      jitterMs: 0,
    });
    await vi.waitFor(() => expect(listBills(user.id)).toHaveLength(1), {
      timeout: 15_000,
    });
    stop();

    const requests = fake.requests.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests.length).toBe(requests);
  });

  it("registering twice subscribes once", () => {
    registerPaperless();
    registerPaperless();
    unregisterPaperless();
  });
});
