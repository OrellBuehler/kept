import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { first, getDB, paperlessReportUploads } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import type { PaperlessClient } from "./client";
import { PaperlessError } from "./client";
import {
  getClient,
  getConnectionRow,
  rememberServerInfo,
  type ConnectionRow,
} from "./connection";

export interface ReportUploadInput {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  /** YYYY-MM-DD */
  created: string;
  /** e.g. "balance-history"; free text, stored for display. */
  kind: string;
}

/** A pending row without a task this young is being uploaded by another call. */
const IN_FLIGHT_MS = 2 * 60 * 1000;

export type UploadStatus = "pending" | "success" | "failed";

export interface ReportUploadResult {
  id: string;
  status: UploadStatus;
  paperlessDocumentId: number | null;
  /** True when this exact file had been uploaded before and nothing was sent. */
  alreadyUploaded: boolean;
}

/** Another call is sending this exact file right now. */
function inFlight(id: string): ReportUploadResult {
  return {
    id,
    status: "pending",
    paperlessDocumentId: null,
    alreadyUploaded: true,
  };
}

/** Waits between task polls; total stays around a minute. */
export const DEFAULT_POLL_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export interface UploadOptions {
  pollDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const uploadResponseSchema = z.union([
  z.string().min(1),
  z.object({ task_id: z.string().min(1) }).transform((o) => o.task_id),
]);

const taskSchema = z.object({
  task_id: z.string().nullish(),
  status: z.string(),
  result: z.string().nullish(),
  // 2.x returns a string, 3.x an integer.
  related_document: z.union([z.string(), z.number()]).nullish(),
  related_document_ids: z.array(z.number()).nullish(),
  result_data: z
    .object({
      document_id: z.number().nullish(),
      duplicate_of: z.number().nullish(),
    })
    .nullish(),
});

// v9 answers with a bare list, v10 with a paginated object.
const taskListSchema = z.union([
  z.array(taskSchema),
  z.object({ results: z.array(taskSchema) }).transform((o) => o.results),
]);

export type TaskState =
  | { state: "pending" }
  | { state: "success"; documentId: number | null }
  | { state: "failed"; documentId: number | null };

function asId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d{1,12}$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** Interprets one task in either API shape. */
export function interpretTask(task: z.output<typeof taskSchema>): TaskState {
  const status = task.status.toLowerCase();
  if (status === "success") {
    const id =
      asId(task.related_document) ??
      asId(task.related_document_ids?.[0]) ??
      asId(task.result_data?.document_id) ??
      asId(/\bid (\d+)\b/.exec(task.result ?? "")?.[1]);
    return { state: "success", documentId: id };
  }
  if (status === "failure" || status === "revoked") {
    // A duplicate means Paperless already has this exact file.
    const duplicate =
      asId(task.result_data?.duplicate_of) ??
      asId(/duplicate of .*\(#(\d+)\)/i.exec(task.result ?? "")?.[1]);
    return { state: "failed", documentId: duplicate };
  }
  return { state: "pending" };
}

async function lookupTask(
  client: PaperlessClient,
  taskId: string,
): Promise<TaskState> {
  const tasks = await client.json("tasks", taskListSchema, {
    query: { task_id: taskId },
  });
  const task = tasks[0];
  // Right after the upload the task can be missing for a moment.
  return task ? interpretTask(task) : { state: "pending" };
}

async function findUpload(row: ConnectionRow, sha256: string) {
  return (
    (await first(
      getDB()
        .select()
        .from(paperlessReportUploads)
        .where(
          and(
            eq(paperlessReportUploads.userId, row.userId),
            eq(paperlessReportUploads.connectionId, row.id),
            eq(paperlessReportUploads.sha256, sha256),
          ),
        )
        .limit(1),
    )) ?? null
  );
}

async function updateUpload(
  userId: string,
  id: string,
  patch: Partial<typeof paperlessReportUploads.$inferInsert>,
): Promise<void> {
  await getDB()
    .update(paperlessReportUploads)
    .set(patch)
    .where(
      and(
        eq(paperlessReportUploads.userId, userId),
        eq(paperlessReportUploads.id, id),
      ),
    );
}

async function settle(
  client: PaperlessClient,
  userId: string,
  uploadId: string,
  taskId: string,
  options: UploadOptions,
): Promise<ReportUploadResult> {
  const delays = options.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  let state: TaskState = { state: "pending" };
  for (let i = 0; i <= delays.length; i++) {
    state = await lookupTask(client, taskId);
    if (state.state !== "pending" || i === delays.length) break;
    await sleep(delays[i]!);
  }
  if (
    state.state === "success" ||
    (state.state === "failed" && state.documentId)
  ) {
    await updateUpload(userId, uploadId, {
      status: "success",
      paperlessDocumentId: state.documentId,
      error: null,
    });
    return {
      id: uploadId,
      status: "success",
      paperlessDocumentId: state.documentId,
      alreadyUploaded: false,
    };
  }
  if (state.state === "failed") {
    await updateUpload(userId, uploadId, {
      status: "failed",
      error: "Paperless could not process the file.",
    });
    return {
      id: uploadId,
      status: "failed",
      paperlessDocumentId: null,
      alreadyUploaded: false,
    };
  }
  return {
    id: uploadId,
    status: "pending",
    paperlessDocumentId: null,
    alreadyUploaded: false,
  };
}

/**
 * Sends a finished report to Paperless. Idempotent per file content: the same
 * bytes are never uploaded twice to one connection. When the task has not
 * finished after the polling budget the upload stays `pending` and a later
 * `resolvePendingUploads` settles it.
 */
export async function uploadReport(
  userId: string,
  input: ReportUploadInput,
  options: UploadOptions = {},
): Promise<ReportUploadResult> {
  const { row, client } = await getClient(userId);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await findUpload(row, sha256);

  if (existing?.status === "success") {
    return {
      id: existing.id,
      status: "success",
      paperlessDocumentId: existing.paperlessDocumentId,
      alreadyUploaded: true,
    };
  }
  if (
    existing?.status === "pending" &&
    !existing.taskId &&
    Date.now() - existing.updatedAt.getTime() < IN_FLIGHT_MS
  ) {
    // Another call is sending this file right now.
    return inFlight(existing.id);
  }
  if (existing?.status === "pending" && existing.taskId) {
    const result = await settle(
      client,
      userId,
      existing.id,
      existing.taskId,
      options,
    );
    await rememberServerInfo(row, client);
    return { ...result, alreadyUploaded: result.status !== "failed" };
  }

  // Claim the content hash first so concurrent calls cannot both upload. Both
  // ways are one atomic statement: a conditional update of the row as it was
  // read, or an insert guarded by the unique (connection, hash) index. Whoever
  // loses sees the other call's upload as in flight.
  let upload: { id: string };
  if (existing) {
    const claimed = await getDB()
      .update(paperlessReportUploads)
      .set({ status: "pending", error: null, taskId: null })
      .where(
        and(
          eq(paperlessReportUploads.userId, userId),
          eq(paperlessReportUploads.id, existing.id),
          eq(paperlessReportUploads.status, existing.status),
          eq(paperlessReportUploads.updatedAt, existing.updatedAt),
        ),
      )
      .returning({ id: paperlessReportUploads.id });
    if (claimed.length === 0) return inFlight(existing.id);
    upload = existing;
  } else {
    const [inserted] = await getDB()
      .insert(paperlessReportUploads)
      .values({
        userId,
        connectionId: row.id,
        reportKind: input.kind,
        sha256,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const winner = await findUpload(row, sha256);
      if (!winner) {
        throw new LedgerError(
          "conflict",
          "The upload was changed at the same time. Try again.",
        );
      }
      return winner.status === "success"
        ? {
            id: winner.id,
            status: "success",
            paperlessDocumentId: winner.paperlessDocumentId,
            alreadyUploaded: true,
          }
        : inFlight(winner.id);
    }
    upload = inserted;
  }

  const form = new FormData();
  form.append(
    "document",
    new Blob([input.bytes as Uint8Array<ArrayBuffer>], {
      type: "application/pdf",
    }),
    input.fileName,
  );
  form.append("title", input.title);
  form.append("created", input.created);
  let taskId: string;
  try {
    taskId = await client.json(
      "documents/post_document",
      uploadResponseSchema,
      {
        method: "POST",
        form,
        timeoutMs: 60_000,
      },
    );
  } catch (err) {
    if (err instanceof PaperlessError) {
      await updateUpload(userId, upload.id, {
        status: "failed",
        error: err.code,
      });
    }
    throw err;
  }
  await updateUpload(userId, upload.id, { taskId });
  const result = await settle(client, userId, upload.id, taskId, options);
  await rememberServerInfo(row, client);
  return result;
}

/** Re-checks uploads whose processing had not finished; returns how many settled. */
export async function resolvePendingUploads(
  userId: string,
  options: UploadOptions = { pollDelaysMs: [] },
): Promise<number> {
  const row = await getConnectionRow(userId);
  if (!row) return 0;
  const pending = (
    await getDB()
      .select()
      .from(paperlessReportUploads)
      .where(
        and(
          eq(paperlessReportUploads.userId, userId),
          eq(paperlessReportUploads.connectionId, row.id),
          eq(paperlessReportUploads.status, "pending"),
        ),
      )
  ).filter((u) => u.taskId);
  if (pending.length === 0) return 0;
  const { client } = await getClient(userId);
  let settled = 0;
  for (const u of pending) {
    const r = await settle(client, userId, u.id, u.taskId!, options);
    if (r.status !== "pending") settled++;
  }
  return settled;
}

export interface UploadView {
  id: string;
  reportKind: string;
  status: UploadStatus;
  paperlessDocumentId: number | null;
  error: string | null;
  createdAt: number;
}

export async function listUploads(
  userId: string,
  limit = 20,
): Promise<UploadView[]> {
  const rows = await getDB()
    .select()
    .from(paperlessReportUploads)
    .where(eq(paperlessReportUploads.userId, userId))
    .orderBy(desc(paperlessReportUploads.createdAt))
    .limit(limit);
  return rows.map((u) => ({
    id: u.id,
    reportKind: u.reportKind,
    status: u.status,
    paperlessDocumentId: u.paperlessDocumentId,
    error: u.error,
    createdAt: u.createdAt.getTime(),
  }));
}
