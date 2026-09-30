import { getAccount } from "$lib/server/ledger/accounts";
import { LedgerError } from "$lib/server/ledger/errors";
import { MAX_UPLOAD_BYTES, storePending, type PendingMeta } from "./pending";
import { getCsvProfile } from "./profiles";

/**
 * Stores an uploaded file for the given account (which must belong to the
 * user and not be archived) and says where the flow continues: csv/xlsx
 * without a saved mapping go to the mapping page first.
 */
export async function startUpload(
  userId: string,
  accountId: string,
  file: File,
): Promise<{ meta: PendingMeta; needsMapping: boolean }> {
  const account = getAccount(userId, accountId);
  if (account.archived) {
    throw new LedgerError(
      "invalid",
      "This account is archived; unarchive it to import into it.",
      "accountId",
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new LedgerError(
      "invalid",
      `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      "file",
    );
  }
  const meta = storePending(userId, {
    accountId: account.id,
    fileName: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  const needsMapping =
    meta.format !== "camt053" && getCsvProfile(userId, account.id) === null;
  return { meta, needsMapping };
}
