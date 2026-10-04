import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listBills } from "$lib/server/bills/bills";
import { getConnectionRow } from "$lib/server/integrations/paperless/connection";
import { startFakePaperless } from "$lib/server/integrations/paperless/fake-server";
import {
  billPdf,
  seedConnection,
} from "$lib/server/integrations/paperless/testing";
import { resetWebhookState } from "$lib/server/integrations/paperless/webhook";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { createTestEvent } from "$lib/testing/event";
import { isPublicPath } from "$lib/server/auth/routing";
import { POST } from "./+server";

const fake = startFakePaperless();
afterAll(() => fake.stop());

let pdf: Uint8Array;
beforeAll(async () => {
  pdf = await billPdf();
}, 60_000);

describe("POST /api/public/paperless/[token]", () => {
  useTestDB();
  useTestStore();
  let user: TestUser;
  let token: string;
  let secret: string;

  beforeEach(async () => {
    resetWebhookState();
    fake.docs.clear();
    fake.requests = [];
    user = await createTestUser();
    secret = seedConnection(user.id, fake).webhookSecret!;
    token = getConnectionRow(user.id)!.webhookToken;
  });

  const call = async (opts: {
    token?: string;
    secret?: string | null;
    body?: string;
  }) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (opts.secret !== null) headers["X-Kept-Secret"] = opts.secret ?? secret;
    const event = createTestEvent({
      method: "POST",
      params: { token: opts.token ?? token },
      body: opts.body ?? JSON.stringify({ document_id: "5" }),
      headers,
    });
    return POST(event as never);
  };

  it("is reachable without a session", () => {
    expect(isPublicPath(`/api/public/paperless/${token}`)).toBe(true);
  });

  it("answers 404 for an unknown token and 401 for a wrong or missing secret", async () => {
    expect((await call({ token: "nope" })).status).toBe(404);
    expect((await call({ secret: "wrong" })).status).toBe(401);
    expect((await call({ secret: null })).status).toBe(401);
    const res = await call({ secret: "wrong" });
    expect(await res.text()).toBe("");
    expect(fake.requests).toHaveLength(0);
  });

  it("answers 400 for a body that is not the expected JSON", async () => {
    expect((await call({ body: "not json" })).status).toBe(400);
    expect((await call({ body: "{}" })).status).toBe(400);
  });

  it("answers 202 immediately and imports the document afterwards", async () => {
    fake.addDoc({ id: 5, original: pdf });
    const res = await call({});
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    await expect
      .poll(() => listBills(user.id).length, { timeout: 20_000 })
      .toBe(1);
  });

  it("a repeated delivery does not create a second bill", async () => {
    fake.addDoc({ id: 5, original: pdf });
    expect((await call({})).status).toBe(202);
    await expect
      .poll(() => listBills(user.id).length, { timeout: 20_000 })
      .toBe(1);
    expect((await call({})).status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(listBills(user.id)).toHaveLength(1);
  });

  it("another user's secret does not open this connection", async () => {
    const other = await createTestUser();
    const otherSecret = seedConnection(other.id, fake).webhookSecret!;
    expect((await call({ secret: otherSecret })).status).toBe(401);
  });
});
