import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listBills } from "$lib/server/bills/bills";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestStore } from "$lib/testing/store";
import { eq } from "drizzle-orm";
import { getDB } from "$lib/server/db";
import { paperlessConnections } from "$lib/server/db/schema";
import { LedgerError } from "$lib/server/ledger/errors";
import { getConnectionRow } from "./connection";
import { startFakePaperless } from "./fake-server";
import { saveConnectionVerified } from "./identity";
import { syncConnection } from "./sync";
import { billPdf, seedConnection } from "./testing";

const fake = startFakePaperless();
const other = startFakePaperless();
afterAll(() => {
  fake.stop();
  other.stop();
});

let pdfEnergy: Uint8Array;
let pdfWater: Uint8Array;
beforeAll(async () => {
  pdfEnergy = await billPdf({ name: "Example Energy Ltd" });
  pdfWater = await billPdf({ name: "Sample Water AG", message: "Water 2026" });
}, 60_000);

const move = (userId: string, baseUrl: string, extra = {}) =>
  saveConnectionVerified(userId, {
    baseUrl,
    token: null,
    allowInsecureTls: false,
    ...extra,
  });

async function rejection(promise: Promise<unknown>): Promise<LedgerError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LedgerError);
    return err as LedgerError;
  }
  throw new Error("expected the save to be refused");
}

describe("saveConnectionVerified", () => {
  useTestDB();
  useTestStore();
  let user: TestUser;

  beforeEach(async () => {
    for (const f of [fake, other]) {
      f.docs.clear();
      f.requests = [];
      f.prefix = "";
      f.token = "test-token";
    }
    user = await createTestUser();
    await seedConnection(user.id, fake);
    fake.addDoc({ id: 95, original: pdfEnergy });
    fake.addDoc({ id: 96, original: pdfWater });
    await syncConnection(user.id);
  });

  it("keeps the links when the new address serves the same documents", async () => {
    other.addDoc({ id: 95, original: pdfEnergy });
    const before = (await getConnectionRow(user.id))!;

    await move(user.id, other.baseUrl);

    expect(await getConnectionRow(user.id)).toMatchObject({
      baseUrl: other.baseUrl,
      instanceKey: before.instanceKey,
    });
    expect(await listBills(user.id)).toHaveLength(2);
  });

  it("never contacts a private address the user may not use", async () => {
    other.addDoc({ id: 95, original: pdfEnergy });
    const before = (await getConnectionRow(user.id))!;

    const err = await rejection(
      move(user.id, other.baseUrl, { allowPrivateNetwork: false }),
    );

    expect(err.field).toBe("baseUrl");
    expect(other.requests).toHaveLength(0);
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(before.baseUrl);
  });

  it("asks for the token again instead of failing when the stored one cannot be decrypted", async () => {
    other.addDoc({ id: 95, original: pdfEnergy });
    await getDB()
      .update(paperlessConnections)
      .set({ tokenEncrypted: "v1.broken.broken" })
      .where(eq(paperlessConnections.userId, user.id));

    const err = await rejection(move(user.id, other.baseUrl));

    expect(err.field).toBe("token");
    expect(err.message).toContain("KEPT_SECRET_KEY");
    expect(other.requests).toHaveLength(0);
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(fake.baseUrl);
  });

  it("accepts the move when only some sampled documents still match", async () => {
    other.addDoc({ id: 96, original: pdfWater });
    await move(user.id, other.baseUrl);
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(other.baseUrl);
  });

  it("refuses an address whose documents are missing", async () => {
    const err = await rejection(move(user.id, other.baseUrl));
    expect(err.field).toBe("baseUrl");
    expect(err.message).toContain("different Paperless server");
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(fake.baseUrl);
  });

  it("refuses an address that serves other content under the same numbers", async () => {
    other.addDoc({ id: 95, original: pdfWater });
    other.addDoc({ id: 96, original: pdfEnergy });
    const err = await rejection(move(user.id, other.baseUrl));
    expect(err.field).toBe("baseUrl");
    expect(err.message).toContain("different Paperless server");
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(fake.baseUrl);
  });

  it("reports an unreachable address instead of keeping the links", async () => {
    const err = await rejection(move(user.id, "http://127.0.0.1:1"));
    expect(err.field).toBe("baseUrl");
    expect(err.message).toContain("could not be reached");
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(fake.baseUrl);
  });

  it("reports a rejected token on the new address", async () => {
    other.addDoc({ id: 95, original: pdfEnergy });
    other.token = "something-else";
    const err = await rejection(move(user.id, other.baseUrl));
    expect(err.field).toBe("baseUrl");
    expect(err.message).toContain("token");
  });

  it("does not check anything when the user says it is a different server", async () => {
    await move(user.id, other.baseUrl, { differentInstance: true });
    expect(other.requests).toHaveLength(0);
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(other.baseUrl);
  });

  it("does not check when the address is unchanged", async () => {
    fake.requests = [];
    await move(user.id, fake.baseUrl);
    expect(fake.requests).toHaveLength(0);
  });

  it("does not check a connection without imported documents", async () => {
    const fresh = await createTestUser();
    await seedConnection(fresh.id, fake);
    await move(fresh.id, other.baseUrl);
    expect(other.requests).toHaveLength(0);
    expect((await getConnectionRow(fresh.id))!.baseUrl).toBe(other.baseUrl);
  });

  it("only samples the current user's documents", async () => {
    const fresh = await createTestUser();
    await seedConnection(fresh.id, fake);
    await move(fresh.id, other.baseUrl);
    expect(other.requests).toHaveLength(0);
    expect((await getConnectionRow(user.id))!.baseUrl).toBe(fake.baseUrl);
  });

  it("samples at most three documents", async () => {
    for (const id of [97, 98, 99]) fake.addDoc({ id, original: pdfEnergy });
    await syncConnection(user.id);
    await rejection(move(user.id, other.baseUrl));
    expect(other.requestsTo("/api/documents/", "GET")).toHaveLength(3);
  });
});
