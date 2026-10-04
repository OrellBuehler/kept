import { billFromExtraction, pdfErrorMessage, type BillDraft } from "./draft";
import { readDocument } from "./documents";
import {
  PdfExtractError,
  extractBillFromPdf,
  type BillExtraction,
} from "./pdf-extract";
import type { BillExtractionMeta } from "./bills";

const CACHE_LIMIT = 50;
const cache = new Map<string, BillExtraction>();

const key = (userId: string, documentId: string) => `${userId}:${documentId}`;

/** Remembers an extraction so the form shown after an upload does not scan the PDF again. */
export function cacheExtraction(
  userId: string,
  documentId: string,
  extraction: BillExtraction,
): void {
  const k = key(userId, documentId);
  cache.delete(k);
  cache.set(k, extraction);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function clearExtractionCache(): void {
  cache.clear();
}

export interface DocumentDraft {
  draft: BillDraft | null;
  extraction: BillExtractionMeta;
}

/**
 * Extraction for a stored document as a form draft. A PDF that cannot be read
 * yields no draft and the reason as a warning, so the user can still fill the form by hand.
 */
export async function draftForDocument(
  userId: string,
  documentId: string,
  options: { refresh?: boolean } = {},
): Promise<DocumentDraft> {
  let extraction = options.refresh
    ? undefined
    : cache.get(key(userId, documentId));
  if (!extraction) {
    const { bytes } = await readDocument(userId, documentId);
    try {
      extraction = await extractBillFromPdf(bytes);
    } catch (err) {
      if (!(err instanceof PdfExtractError)) throw err;
      console.warn("bill extraction failed", err.code);
      return {
        draft: null,
        extraction: { source: "none", warnings: [pdfErrorMessage(err.code)] },
      };
    }
    cacheExtraction(userId, documentId, extraction);
  }
  const { draft, warnings } = billFromExtraction(extraction);
  return { draft, extraction: { source: extraction.source, warnings } };
}
