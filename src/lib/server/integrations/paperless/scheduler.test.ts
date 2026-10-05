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
import { drainDetached } from "$lib/server/detached";
import { clearEventListeners } from "$lib/server/events";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { setEnabled } from "./connection";
import { startFakePaperless } from "./fake-server";
import { unregisterPaperless, registerPaperless } from "./index";
import { runCatchUp, startScheduler } from "./scheduler";
import { isSyncing, syncConnection } from "./sync";
import { billPdf, seedConnection } from "./testing";
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
  useTestStore();
  let user: TestUser;

  beforeEach(async () => {
    fake.requests = [];
    fake.docs.clear();
    fake.gate = null;
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
    await seedConnection(user.id, fake);
    await seedConnection(other.id, fake);
    await setEnabled(other.id, false);
    fake.addDoc({ id: 1, original: pdf });

    await runCatchUp();

    expect(await listBills(user.id)).toHaveLength(1);
    expect(await listBills(other.id)).toHaveLength(0);
  });

  it("skips a connection that is already syncing", async () => {
    await seedConnection(user.id, fake);
    fake.addDoc({ id: 1, original: pdf });
    // The sync's first request is held until the test releases it.
    let release!: () => void;
    fake.gate = new Promise<void>((resolve) => (release = resolve));
    const running = syncConnection(user.id);
    await vi.waitFor(() => {
      expect(isSyncing(user.id)).toBe(true);
      expect(fake.requests.length).toBeGreaterThan(0);
    });
    fake.requests = [];

    try {
      await runCatchUp();
      expect(fake.requests).toHaveLength(0);
    } finally {
      release();
    }

    await running;
    expect(isSyncing(user.id)).toBe(false);
  });

  it("a failing connection does not stop the others", async () => {
    const other = await createTestUser();
    await seedConnection(user.id, fake);
    await seedConnection(other.id, fake);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.addDoc({ id: 1, original: pdf });
    // A stored address that cannot be used makes the first connection fail.
    await getDB()
      .update(paperlessConnections)
      .set({ baseUrl: "not a url" })
      .where(eq(paperlessConnections.userId, user.id));

    await runCatchUp();

    expect(await listBills(other.id)).toHaveLength(1);
  });

  it("runs on a timer and can be stopped", async () => {
    await seedConnection(user.id, fake);
    fake.addDoc({ id: 1, original: pdf });
    const stop = startScheduler({
      intervalMs: 60_000,
      firstRunDelayMs: 10,
      jitterMs: 0,
    });
    await vi.waitFor(
      async () => expect(await listBills(user.id)).toHaveLength(1),
      {
        timeout: 15_000,
      },
    );
    stop();
    // A tick that was already running finishes before the count is taken.
    await drainDetached();

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
