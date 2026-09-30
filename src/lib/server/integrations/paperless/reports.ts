import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDB, paperlessReportUploads } from "$lib/server/db";
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

export type UploadStatus = "pending" | "success" | "failed";

export interface ReportUploadResult {
  status: UploadStatus;
  paperlessDocumentId: number | null;
  /** True when this exact file had been uploaded before and nothing was sent. */
  alreadyUploaded: boolean;
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

function findUpload(row: ConnectionRow, sha256: string) {
  return (
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
      .get() ?? null
  );
}

function updateUpload(
  userId: string,
  id: string,
  patch: Partial<typeof paperlessReportUploads.$inferInsert>,
) {
  getDB()
    .update(paperlessReportUploads)
    .set(patch)
    .where(
      and(
        eq(paperlessReportUploads.userId, userId),
        eq(paperlessReportUploads.id, id),
      ),
    )
    .run();
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
    updateUpload(userId, uploadId, {
      status: "success",
      paperlessDocumentId: state.documentId,
      error: null,
    });
    return {
      status: "success",
      paperlessDocumentId: state.documentId,
      alreadyUploaded: false,
    };
  }
  if (state.state === "failed") {
    updateUpload(userId, uploadId, {
      status: "failed",
      error: "Paperless could not process the file.",
    });
    return {
      status: "failed",
      paperlessDocumentId: null,
      alreadyUploaded: false,
    };
  }
  return {
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
  const { row, client } = getClient(userId);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = findUpload(row, sha256);

  if (existing?.status === "success") {
    return {
      status: "success",
      paperlessDocumentId: existing.paperlessDocumentId,
      alreadyUploaded: true,
    };
  }
  if (existing?.status === "pending" && existing.taskId) {
    const result = await settle(
      client,
      userId,
      existing.id,
      existing.taskId,
      options,
    );
    rememberServerInfo(row, client);
    return { ...result, alreadyUploaded: result.status !== "failed" };
  }

  // Claim the content hash first so concurrent calls cannot both upload.
  const upload =
    existing ??
    getDB()
      .insert(paperlessReportUploads)
      .values({
        userId,
        connectionId: row.id,
        reportKind: input.kind,
        sha256,
        status: "pending",
      })
      .returning()
      .get();
  if (existing) {
    updateUpload(userId, existing.id, {
      status: "pending",
      error: null,
      taskId: null,
    });
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
      updateUpload(userId, upload.id, { status: "failed", error: err.code });
    }
    throw err;
  }
  updateUpload(userId, upload.id, { taskId });
  const result = await settle(client, userId, upload.id, taskId, options);
  rememberServerInfo(row, client);
  return result;
}

/** Re-checks uploads whose processing had not finished; returns how many settled. */
export async function resolvePendingUploads(
  userId: string,
  options: UploadOptions = { pollDelaysMs: [] },
): Promise<number> {
  const row = getConnectionRow(userId);
  if (!row) return 0;
  const pending = getDB()
    .select()
    .from(paperlessReportUploads)
    .where(
      and(
        eq(paperlessReportUploads.userId, userId),
        eq(paperlessReportUploads.connectionId, row.id),
        eq(paperlessReportUploads.status, "pending"),
      ),
    )
    .all()
    .filter((u) => u.taskId);
  if (pending.length === 0) return 0;
  const { client } = getClient(userId);
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

export function listUploads(userId: string, limit = 20): UploadView[] {
  return getDB()
    .select()
    .from(paperlessReportUploads)
    .where(eq(paperlessReportUploads.userId, userId))
    .orderBy(desc(paperlessReportUploads.createdAt))
    .limit(limit)
    .all()
    .map((u) => ({
      id: u.id,
      reportKind: u.reportKind,
      status: u.status,
      paperlessDocumentId: u.paperlessDocumentId,
      error: u.error,
      createdAt: u.createdAt.getTime(),
    }));
}
