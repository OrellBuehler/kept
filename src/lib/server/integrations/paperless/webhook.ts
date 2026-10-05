import { z } from "zod";
import { getConnectionByWebhookToken, secretMatches } from "./connection";
import { errorCode } from "./client";
import { syncConnection } from "./sync";

export const SECRET_HEADER = "x-kept-secret";
/** Wrong-secret attempts per connection and minute before answering 429. */
export const FAILED_PER_MINUTE = 20;
/** Generous cap for valid deliveries (a bulk import of many documents). */
export const VALID_PER_MINUTE = 600;

export const webhookConfig = {
  /** Waits before re-checking a document that is not visible yet (Paperless may fire before commit). */
  retryDelaysMs: [5_000, 15_000, 45_000],
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** Paperless renders every placeholder as a string, so accept numeric strings too. */
export const webhookBodySchema = z.object({
  document_id: z.union([
    z.number().int().positive(),
    z
      .string()
      .trim()
      .regex(/^\d{1,12}$/)
      .transform(Number)
      .refine((n) => n > 0),
  ]),
});

const failures = new Map<string, number[]>();
const accepted = new Map<string, number[]>();
const pending = new Map<string, Promise<void>>();

function recent(map: Map<string, number[]>, key: string, now: number) {
  const list = (map.get(key) ?? []).filter((t) => now - t < 60_000);
  map.set(key, list);
  return list;
}

/** Tests only. */
export function resetWebhookState(): void {
  failures.clear();
  accepted.clear();
  pending.clear();
}

export type WebhookOutcome =
  { status: 202; done: Promise<void> } | { status: 400 | 401 | 404 | 429 };

const RETRYABLE_ERRORS = new Set(["network", "server", "busy", "tls"]);

async function runJob(userId: string, documentId: number): Promise<void> {
  const delays = webhookConfig.retryDelaysMs;
  for (let attempt = 0; ; attempt++) {
    const result = await syncConnection(userId, { documentIds: [documentId] });
    const retry =
      result.missing.includes(documentId) ||
      (result.error !== null && RETRYABLE_ERRORS.has(result.error));
    if (!retry || attempt >= delays.length) return;
    await webhookConfig.sleep(delays[attempt]!);
  }
}

/**
 * Authenticates a workflow webhook delivery and starts a background sync of
 * the announced document. The payload is only a hint: the document is fetched
 * from Paperless with the stored token. Duplicate deliveries for a document that
 * is already being handled share one job.
 */
export async function handleWebhook(input: {
  token: string;
  secret: string | null;
  readBody: () => Promise<unknown>;
  now?: number;
}): Promise<WebhookOutcome> {
  const row = await getConnectionByWebhookToken(input.token);
  if (!row || !row.enabled) return { status: 404 };
  const now = input.now ?? Date.now();
  const failed = recent(failures, row.id, now);
  if (failed.length >= FAILED_PER_MINUTE) return { status: 429 };
  if (!input.secret || !secretMatches(row, input.secret)) {
    failed.push(now);
    return { status: 401 };
  }
  const ok = recent(accepted, row.id, now);
  if (ok.length >= VALID_PER_MINUTE) return { status: 429 };
  ok.push(now);
  let body: unknown;
  try {
    body = await input.readBody();
  } catch (err) {
    if (err instanceof SyntaxError) return { status: 400 };
    throw err;
  }
  const parsed = webhookBodySchema.safeParse(body);
  if (!parsed.success) return { status: 400 };

  const key = `${row.id}:${parsed.data.document_id}`;
  let job = pending.get(key);
  if (!job) {
    job = runJob(row.userId, parsed.data.document_id)
      .catch((err) => {
        console.error("paperless webhook sync failed", errorCode(err));
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return { status: 202, done: job };
}
