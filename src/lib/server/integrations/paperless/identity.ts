import { and, desc, eq, isNotNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { decryptSecret } from "$lib/server/crypto";
import { getDB, paperlessDocuments } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import {
  PaperlessClient,
  PaperlessError,
  describeError,
  normalizeBaseUrl,
} from "./client";
import {
  getConnectionRow,
  isTokenUnreadable,
  privateNetworkGuard,
  saveConnection,
  type ConnectionRow,
  type SaveConnectionInput,
  type SaveConnectionResult,
} from "./connection";
import { fetchPdf } from "./sync";

/** A reachable server answers at once; do not make the user wait. */
const CHECK_TIMEOUT_MS = 5_000;

/** How many linked documents are compared with the new address. */
const SAMPLE_SIZE = 3;

const DIFFERENT_SERVER_HINT =
  'The documents Kept imported are not on this server. If it is another or a reinstalled Paperless server, turn on "This is a different Paperless server".';

/** Codes that mean "this server does not have that document", as opposed to "could not ask". */
const MISSING_CODES = new Set([
  "not_found",
  "forbidden",
  "wrong_type",
  "too_large",
  "bad_request",
]);

const docSchema = z.object({
  id: z.number().int(),
  mime_type: z.string().nullish(),
  archived_file_name: z.string().nullish(),
});

async function documentMatches(
  client: PaperlessClient,
  paperlessId: number,
  contentSha256: string,
): Promise<boolean> {
  try {
    const doc = await client.json(`documents/${paperlessId}`, docSchema);
    const bytes = await fetchPdf(client, doc);
    if (bytes === null) return false;
    return createHash("sha256").update(bytes).digest("hex") === contentSha256;
  } catch (err) {
    if (err instanceof PaperlessError && MISSING_CODES.has(err.code)) {
      return false;
    }
    throw err;
  }
}

/**
 * An address change keeps the links to the old server's documents, which is only right when the
 * new address is the same server. Compares the content hash recorded at sync time of a few
 * linked documents with what the new address serves; at least one must match.
 */
async function verifySameServer(
  existing: ConnectionRow,
  baseUrl: string,
  input: SaveConnectionInput,
): Promise<void> {
  const samples = getDB()
    .select({
      paperlessId: paperlessDocuments.paperlessId,
      contentSha256: paperlessDocuments.contentSha256,
    })
    .from(paperlessDocuments)
    .where(
      and(
        eq(paperlessDocuments.userId, existing.userId),
        eq(paperlessDocuments.connectionId, existing.id),
        eq(paperlessDocuments.status, "imported"),
        isNotNull(paperlessDocuments.billId),
        isNotNull(paperlessDocuments.contentSha256),
      ),
    )
    .orderBy(desc(paperlessDocuments.modified))
    .limit(SAMPLE_SIZE)
    .all();
  // Nothing recorded to compare with, and no link that could go wrong.
  if (samples.length === 0) return;

  const token = input.token?.trim() || decryptSecret(existing.tokenEncrypted);
  const client = new PaperlessClient({
    baseUrl,
    token,
    allowInsecureTls: input.allowInsecureTls,
    apiVersion: null,
    timeoutMs: CHECK_TIMEOUT_MS,
    downloadTimeoutMs: CHECK_TIMEOUT_MS * 3,
    // The new address is not saved yet, so it gets the same private-network check as saving it.
    guard: privateNetworkGuard(input.allowPrivateNetwork !== false),
  });
  for (const sample of samples) {
    let matches: boolean;
    try {
      matches = await documentMatches(
        client,
        sample.paperlessId,
        sample.contentSha256!,
      );
    } catch (err) {
      throw new LedgerError(
        "invalid",
        `Kept could not check the new address: ${describeError(err)}`,
        "baseUrl",
      );
    }
    if (matches) return;
  }
  throw new LedgerError("invalid", DIFFERENT_SERVER_HINT, "baseUrl");
}

/** `saveConnection`, but an address change is first checked against the stored documents. */
export async function saveConnectionVerified(
  userId: string,
  input: SaveConnectionInput,
): Promise<SaveConnectionResult> {
  const existing = getConnectionRow(userId);
  // Without a new token the stored one is used for the check; if it cannot be read, ask for it.
  if (existing && !input.token?.trim() && isTokenUnreadable(existing)) {
    throw new LedgerError(
      "invalid",
      new PaperlessError("token_unreadable").message,
      "token",
    );
  }
  if (existing && input.differentInstance !== true) {
    let baseUrl: string | null = null;
    try {
      baseUrl = normalizeBaseUrl(input.baseUrl);
    } catch (err) {
      // saveConnection reports the invalid address on the field.
      if (!(err instanceof PaperlessError)) throw err;
    }
    if (baseUrl !== null && baseUrl !== existing.baseUrl) {
      await verifySameServer(existing, baseUrl, input);
    }
  }
  return saveConnection(userId, input);
}
