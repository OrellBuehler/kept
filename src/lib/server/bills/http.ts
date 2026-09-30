import { fail } from "@sveltejs/kit";
import { MAX_DOCUMENT_BYTES } from "./documents";
import { pdfErrorMessage } from "./draft";

export type UploadResult =
  | { ok: true; bytes: Uint8Array; fileName: string; mimeType: string }
  | { ok: false; message: string };

/** Reads the `file` field of a multipart form, enforcing the size cap before buffering. */
export async function readUpload(form: FormData): Promise<UploadResult> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a PDF file." };
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, message: pdfErrorMessage("too_large") };
  }
  return {
    ok: true,
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type,
  };
}

export const uploadFailure = (action: string, message: string) =>
  fail(400, { action, errors: { file: [message] }, values: {} });
