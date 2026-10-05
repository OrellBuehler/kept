import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDB, paperlessReportUploads } from "$lib/server/db";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  interpretTask,
  listUploads,
  resolvePendingUploads,
  uploadReport,
} from "./reports";
import { startFakePaperless } from "./fake-server";
import { seedConnection } from "./testing";

const fake = startFakePaperless();
afterAll(() => fake.stop());

const bytes = (text: string) =>
  new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF`);
const input = (text = "a") => ({
  bytes: bytes(text),
  fileName: "report.pdf",
  title: "Balance history",
  created: "2026-09-30",
  kind: "balance-history",
});
const fast = { pollDelaysMs: [0, 0, 0], sleep: async () => {} };

describe("uploadReport", () => {
  useTestDB();
  let user: TestUser;

  beforeEach(async () => {
    fake.requests = [];
    fake.uploads = [];
    fake.taskShape = "v9";
    fake.taskSteps = ["success"];
    fake.uploadStatus = 200;
    fake.token = "test-token";
    fake.newDocumentId = 900;
    user = await createTestUser();
    await seedConnection(user.id, fake, { source: null });
  });

  it("posts the file as multipart and reads the 2.x task shape (string document id)", async () => {
    const r = await uploadReport(user.id, input(), fast);
    expect(r).toMatchObject({
      status: "success",
      paperlessDocumentId: 900,
      alreadyUploaded: false,
    });
    expect(fake.uploads).toEqual([
      {
        title: "Balance history",
        created: "2026-09-30",
        fileName: "report.pdf",
        size: input().bytes.byteLength,
      },
    ]);
    const post = fake.requestsTo("post_document", "POST")[0]!;
    expect(post.headers.get("content-type")).toContain("multipart/form-data");
    expect(fake.requestsTo("/tasks/")[0]!.query.get("task_id")).toBe(
      "b3f1c0de-0000-4000-8000-000000000001",
    );
    expect((await listUploads(user.id))[0]).toMatchObject({
      status: "success",
      paperlessDocumentId: 900,
      reportKind: "balance-history",
    });
  });

  it("reads the 3.x task shape (paginated, lowercase, result_data)", async () => {
    fake.taskShape = "v10";
    fake.newDocumentId = 901;
    const r = await uploadReport(user.id, input("b"), fast);
    expect(r).toMatchObject({ status: "success", paperlessDocumentId: 901 });
  });

  it("polls through pending and missing tasks", async () => {
    fake.taskSteps = ["missing", "pending", "success"];
    const r = await uploadReport(user.id, input("c"), fast);
    expect(r.status).toBe("success");
    expect(fake.requestsTo("/tasks/")).toHaveLength(3);
  });

  it("stays pending when the task does not finish, and a later call settles it without re-uploading", async () => {
    fake.taskSteps = ["pending"];
    const first = await uploadReport(user.id, input("d"), {
      pollDelaysMs: [0, 0],
      sleep: async () => {},
    });
    expect(first).toMatchObject({
      status: "pending",
      paperlessDocumentId: null,
    });

    fake.taskSteps = ["success"];
    const settled = await resolvePendingUploads(user.id);
    expect(settled).toBe(1);
    expect((await listUploads(user.id))[0]).toMatchObject({
      status: "success",
      paperlessDocumentId: 900,
    });
    expect(fake.uploads).toHaveLength(1);
  });

  it("is idempotent per file content", async () => {
    await uploadReport(user.id, input("e"), fast);
    const again = await uploadReport(user.id, input("e"), fast);
    expect(again).toMatchObject({
      status: "success",
      paperlessDocumentId: 900,
      alreadyUploaded: true,
    });
    expect(fake.uploads).toHaveLength(1);
    expect(await getDB().select().from(paperlessReportUploads)).toHaveLength(1);

    await uploadReport(user.id, input("f"), fast);
    expect(fake.uploads).toHaveLength(2);
  });

  it("treats a duplicate rejection as the existing document (2.x and 3.x)", async () => {
    fake.taskSteps = ["duplicate"];
    fake.duplicateOf = 7;
    const v9 = await uploadReport(user.id, input("g"), fast);
    expect(v9).toMatchObject({ status: "success", paperlessDocumentId: 7 });
    fake.taskShape = "v10";
    fake.duplicateOf = 8;
    const v10 = await uploadReport(user.id, input("h"), fast);
    expect(v10).toMatchObject({ status: "success", paperlessDocumentId: 8 });
  });

  it("records a failed task and retries the same content next time", async () => {
    fake.taskSteps = ["failure"];
    const failed = await uploadReport(user.id, input("i"), fast);
    expect(failed).toMatchObject({
      status: "failed",
      paperlessDocumentId: null,
    });
    expect((await listUploads(user.id))[0]!.error).toBe(
      "Paperless could not process the file.",
    );

    fake.taskSteps = ["success"];
    const retry = await uploadReport(user.id, input("i"), fast);
    expect(retry).toMatchObject({ status: "success", alreadyUploaded: false });
    expect(fake.uploads).toHaveLength(2);
    expect(await getDB().select().from(paperlessReportUploads)).toHaveLength(1);
  });

  it("marks the upload failed when Paperless rejects the request, and can be retried", async () => {
    fake.uploadStatus = 403;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(uploadReport(user.id, input("j"), fast)).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect((await listUploads(user.id))[0]).toMatchObject({
      status: "failed",
      error: "forbidden",
    });

    fake.uploadStatus = 200;
    expect((await uploadReport(user.id, input("j"), fast)).status).toBe(
      "success",
    );
  });

  it("treats a just-claimed upload without a task as in flight", async () => {
    const { getDB, paperlessReportUploads } = await import("$lib/server/db");
    const { getConnectionRow } = await import("./connection");
    const { createHash } = await import("node:crypto");
    await getDB()
      .insert(paperlessReportUploads)
      .values({
        userId: user.id,
        connectionId: (await getConnectionRow(user.id))!.id,
        reportKind: "x",
        sha256: createHash("sha256").update(input("z").bytes).digest("hex"),
        status: "pending",
      });

    const r = await uploadReport(user.id, input("z"), fast);

    expect(r).toMatchObject({ status: "pending", alreadyUploaded: true });
    expect(fake.uploads).toHaveLength(0);

    // A stale claim (crashed upload) is retried.
    await getDB()
      .update(paperlessReportUploads)
      .set({ updatedAt: new Date(Date.now() - 5 * 60_000) });
    expect((await uploadReport(user.id, input("z"), fast)).status).toBe(
      "success",
    );
  });

  it("two concurrent uploads of the same content send it once", async () => {
    const [x, y] = await Promise.all([
      uploadReport(user.id, input("race"), fast),
      uploadReport(user.id, input("race"), fast),
    ]);
    expect(fake.uploads).toHaveLength(1);
    expect([x.alreadyUploaded, y.alreadyUploaded].sort()).toEqual([
      false,
      true,
    ]);
    expect(await listUploads(user.id)).toHaveLength(1);
  });

  it("two concurrent retries of a failed upload send it once", async () => {
    fake.taskSteps = ["failure"];
    await uploadReport(user.id, input("retry"), fast);
    expect(fake.uploads).toHaveLength(1);

    fake.taskSteps = ["success"];
    const [x, y] = await Promise.all([
      uploadReport(user.id, input("retry"), fast),
      uploadReport(user.id, input("retry"), fast),
    ]);
    expect(fake.uploads).toHaveLength(2);
    expect([x.status, y.status].sort()).toEqual(["pending", "success"]);
    expect(await listUploads(user.id)).toHaveLength(1);
  });

  it("keeps uploads of different users apart", async () => {
    const other = await createTestUser();
    await seedConnection(other.id, fake, { source: null });
    await uploadReport(user.id, input("k"), fast);
    await uploadReport(other.id, input("k"), fast);
    expect(fake.uploads).toHaveLength(2);
    expect(await listUploads(other.id)).toHaveLength(1);
    expect(await listUploads(user.id)).toHaveLength(1);
  });

  it("interprets task payloads from both API versions", () => {
    expect(interpretTask({ status: "PENDING" })).toEqual({ state: "pending" });
    expect(interpretTask({ status: "started" })).toEqual({ state: "pending" });
    expect(
      interpretTask({ status: "SUCCESS", related_document: "12" }),
    ).toEqual({ state: "success", documentId: 12 });
    expect(interpretTask({ status: "SUCCESS", related_document: 12 })).toEqual({
      state: "success",
      documentId: 12,
    });
    expect(
      interpretTask({ status: "success", related_document_ids: [5] }),
    ).toEqual({ state: "success", documentId: 5 });
    expect(
      interpretTask({
        status: "SUCCESS",
        result: "New document id 44 created",
      }),
    ).toEqual({ state: "success", documentId: 44 });
    expect(interpretTask({ status: "FAILURE", result: "x" })).toEqual({
      state: "failed",
      documentId: null,
    });
  });
});
