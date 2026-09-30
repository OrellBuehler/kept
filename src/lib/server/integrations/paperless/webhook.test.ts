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
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestDocuments } from "$lib/testing/documents";
import { getConnectionRow, setEnabled } from "./connection";
import { startFakePaperless } from "./fake-server";
import { billPdf, seedConnection } from "./testing";
import {
  RATE_LIMIT_PER_MINUTE,
  handleWebhook,
  resetWebhookState,
  webhookBodySchema,
  webhookConfig,
  type WebhookOutcome,
} from "./webhook";

const fake = startFakePaperless();
afterAll(() => fake.stop());

let pdf: Uint8Array;
beforeAll(async () => {
  pdf = await billPdf();
}, 60_000);

describe("webhookBodySchema", () => {
  it("accepts numeric ids and numeric strings, ignores extra keys", () => {
    expect(webhookBodySchema.parse({ document_id: 12 }).document_id).toBe(12);
    expect(
      webhookBodySchema.parse({ document_id: " 12 ", event: "x" }).document_id,
    ).toBe(12);
    for (const bad of [
      {},
      { document_id: "abc" },
      { document_id: "0" },
      { document_id: -1 },
      { document_id: 1.5 },
      { document_id: null },
      { document_id: "1e3" },
    ]) {
      expect(
        webhookBodySchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe("handleWebhook", () => {
  useTestDB();
  useTestDocuments();
  let user: TestUser;
  let token: string;
  let secret: string;
  const original = { ...webhookConfig };

  beforeEach(async () => {
    resetWebhookState();
    fake.requests = [];
    fake.docs.clear();
    fake.token = "test-token";
    webhookConfig.retryDelaysMs = [0, 0, 0];
    webhookConfig.sleep = async () => {};
    user = await createTestUser();
    secret = seedConnection(user.id, fake).webhookSecret!;
    token = getConnectionRow(user.id)!.webhookToken;
  });
  afterEach(() => {
    Object.assign(webhookConfig, original);
    vi.restoreAllMocks();
  });

  const deliver = (
    over: Partial<Parameters<typeof handleWebhook>[0]> = {},
    body: unknown = { document_id: "5" },
  ) => handleWebhook({ token, secret, readBody: async () => body, ...over });
  const finished = async (o: WebhookOutcome) => {
    expect(o.status).toBe(202);
    if (o.status === 202) await o.done;
  };

  it("rejects unknown tokens (404), disabled connections (404) and bad secrets (401)", async () => {
    expect(await deliver({ token: "unknown" })).toEqual({ status: 404 });
    expect(await deliver({ secret: "wrong" })).toEqual({ status: 401 });
    expect(await deliver({ secret: null })).toEqual({ status: 401 });
    expect(await deliver({ secret: "" })).toEqual({ status: 401 });
    setEnabled(user.id, false);
    expect(await deliver()).toEqual({ status: 404 });
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects malformed bodies with 400 and runs nothing", async () => {
    expect(await deliver({}, { document_id: "x" })).toEqual({ status: 400 });
    expect(await deliver({}, [])).toEqual({ status: 400 });
    expect(
      await deliver({
        readBody: async () => {
          throw new SyntaxError("bad json");
        },
      }),
    ).toEqual({ status: 400 });
    expect(fake.requests).toHaveLength(0);
  });

  it("answers 202 and imports the document in the background", async () => {
    fake.addDoc({ id: 5, original: pdf });
    const outcome = await deliver();
    expect(outcome.status).toBe(202);
    await finished(outcome);
    expect(listBills(user.id)).toHaveLength(1);
  });

  it("treats duplicate deliveries as one job and stays idempotent afterwards", async () => {
    fake.addDoc({ id: 5, original: pdf });
    const [a, b] = await Promise.all([deliver(), deliver()]);
    await finished(a);
    await finished(b);
    expect(listBills(user.id)).toHaveLength(1);
    expect(fake.requestsTo("/download/")).toHaveLength(1);

    await finished(await deliver());
    expect(listBills(user.id)).toHaveLength(1);
    expect(fake.requestsTo("/download/")).toHaveLength(1);
  });

  it("retries while the document is not visible yet", async () => {
    fake.addDoc({ id: 5, original: pdf, hiddenRequests: 2 });
    const sleeps: number[] = [];
    webhookConfig.retryDelaysMs = [5_000, 15_000, 45_000];
    webhookConfig.sleep = async (ms) => void sleeps.push(ms);

    await finished(await deliver());

    expect(listBills(user.id)).toHaveLength(1);
    expect(sleeps).toEqual([5_000, 15_000]);
  });

  it("gives up after the configured retries", async () => {
    fake.addDoc({ id: 5, original: pdf, hiddenRequests: 100 });
    await finished(await deliver());
    expect(listBills(user.id)).toHaveLength(0);
    expect(fake.requestsTo("/api/documents/5/", "GET")).toHaveLength(4);
  });

  it("does not retry documents that simply are not part of the bill source", async () => {
    fake.addDoc({ id: 5, original: pdf, tags: [42] });
    await finished(await deliver());
    expect(listBills(user.id)).toHaveLength(0);
    expect(fake.requestsTo("/api/documents/5/", "GET")).toHaveLength(1);
  });

  it("logs a failing job by code only and never rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.token = "rotated";
    await finished(await deliver());
    expect(listBills(user.id)).toHaveLength(0);
    expect(JSON.stringify(error.mock.calls)).not.toContain("test-token");
  });

  it("rate limits per connection", async () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const o = await deliver({ now, secret: "wrong" });
      expect(o.status).toBe(401);
    }
    expect(await deliver({ now, secret: "wrong" })).toEqual({ status: 429 });
    expect(await deliver({ now: now + 61_000, secret: "wrong" })).toEqual({
      status: 401,
    });
  });

  it("maps a webhook token to exactly one user", async () => {
    const other = await createTestUser();
    const otherSecret = seedConnection(other.id, fake).webhookSecret!;
    const otherToken = getConnectionRow(other.id)!.webhookToken;
    fake.addDoc({ id: 5, original: pdf });

    expect(await deliver({ token, secret: otherSecret })).toEqual({
      status: 401,
    });
    expect(await deliver({ token: otherToken, secret })).toEqual({
      status: 401,
    });
    expect(listBills(user.id)).toHaveLength(0);
    expect(listBills(other.id)).toHaveLength(0);

    await finished(await deliver({ token, secret }));
    expect(listBills(user.id)).toHaveLength(1);
    expect(listBills(other.id)).toHaveLength(0);
  });
});
