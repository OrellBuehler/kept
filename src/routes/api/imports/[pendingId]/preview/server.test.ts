import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import {
  SIMPLE_CSV_PROFILE,
  uploadFixture,
  usePendingDir,
} from "$lib/testing/imports";
import { seedAccount } from "$lib/testing/ledger";
import { POST } from "./+server";

useTestDB();
usePendingDir();

type User = Awaited<ReturnType<typeof createTestUser>>;
const ORIGIN = "http://localhost";

const post = (
  user: User | null,
  pendingId: string,
  body: unknown,
  headers: Record<string, string> = {
    origin: ORIGIN,
    "content-type": "application/json",
  },
) =>
  outcome(async () => {
    const res = (await POST(
      createTestEvent({
        user,
        params: { pendingId },
        url: `${ORIGIN}/api/imports/${pendingId}/preview`,
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers,
      }) as never,
    )) as Response;
    return { status: res.status, body: await res.json() };
  });

async function setup() {
  const user = await createTestUser();
  const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
  const id = uploadFixture(user.id, account.id, "csv/overlap-a.csv");
  return { user, account, id };
}

describe("POST /api/imports/[pendingId]/preview", () => {
  it("returns the mapping context for the draft profile", async () => {
    const { user, id } = await setup();
    const r = await post(user, id, { profile: SIMPLE_CSV_PROFILE });
    expect(r.type).toBe("return");
    const { status, body } = (
      r as { value: { status: number; body: Record<string, unknown> } }
    ).value;
    expect(status).toBe(200);
    expect(body).toMatchObject({
      pendingId: id,
      errors: [],
      rowCount: 6,
      profile: { amountMode: "single" },
    });
    expect((body.preview as unknown[]).length).toBe(5);
    expect((body.detected as unknown[]).length).toBe(5);
    expect((body.sampleRows as unknown[]).length).toBe(6);
  });

  it("reports an invalid draft in errors rather than failing", async () => {
    const { user, id } = await setup();
    const r = await post(user, id, { profile: { amountMode: "single" } });
    const { body } = (
      r as { value: { body: { errors: string[]; profile: unknown } } }
    ).value;
    expect(body.profile).toBeNull();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("requires a session", async () => {
    const { id } = await setup();
    expect(await post(null, id, { profile: {} })).toEqual({
      type: "error",
      status: 401,
    });
  });

  it("rejects cross-origin and origin-less requests", async () => {
    const { user, id } = await setup();
    const json = { "content-type": "application/json" };
    expect(
      await post(
        user,
        id,
        { profile: {} },
        { ...json, origin: "https://evil.example" },
      ),
    ).toEqual({ type: "error", status: 403 });
    expect(await post(user, id, { profile: {} }, json)).toEqual({
      type: "error",
      status: 403,
    });
  });

  it("rejects non-JSON content types", async () => {
    const { user, id } = await setup();
    for (const ct of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ]) {
      expect(
        await post(
          user,
          id,
          { profile: {} },
          { origin: ORIGIN, "content-type": ct },
        ),
      ).toEqual({ type: "error", status: 415 });
    }
  });

  it("rejects malformed bodies", async () => {
    const { user, id } = await setup();
    expect(await post(user, id, "{nope")).toEqual({
      type: "error",
      status: 400,
    });
    expect(await post(user, id, [1, 2])).toEqual({
      type: "error",
      status: 400,
    });
    expect(await post(user, id, "x".repeat(100_001))).toEqual({
      type: "error",
      status: 413,
    });
  });

  it("another user cannot use my pendingId", async () => {
    const { id } = await setup();
    const other = await createTestUser();
    expect(await post(other, id, { profile: SIMPLE_CSV_PROFILE })).toEqual({
      type: "error",
      status: 404,
    });
  });

  it("camt uploads have no mapping", async () => {
    const user = await createTestUser();
    const account = seedAccount(user.id, { iban: EXAMPLE_IBAN });
    const id = uploadFixture(user.id, account.id, "camt053/overlap-a.xml");
    expect(await post(user, id, { profile: {} })).toEqual({
      type: "error",
      status: 400,
    });
  });
});
