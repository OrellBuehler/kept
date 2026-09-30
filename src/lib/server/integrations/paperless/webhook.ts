import { z } from "zod";
import { getConnectionByWebhookToken, secretMatches } from "./connection";
import { errorCode } from "./client";
import { syncConnection } from "./sync";

export const SECRET_HEADER = "x-kept-secret";
export const RATE_LIMIT_PER_MINUTE = 60;

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

const hits = new Map<string, number[]>();
const pending = new Map<string, Promise<void>>();

function allowed(key: string, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/** Tests only. */
export function resetWebhookState(): void {
  hits.clear();
  pending.clear();
}

export type WebhookOutcome =
  { status: 202; done: Promise<void> } | { status: 400 | 401 | 404 | 429 };

const RETRYABLE_ERRORS = new Set(["network", "server", "tls"]);

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
  const row = getConnectionByWebhookToken(input.token);
  if (!row || !row.enabled) return { status: 404 };
  if (!allowed(row.id, input.now ?? Date.now())) return { status: 429 };
  if (!input.secret || !secretMatches(row, input.secret)) {
    return { status: 401 };
  }
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
