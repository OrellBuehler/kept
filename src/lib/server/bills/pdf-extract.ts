import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { QrBillParseError, parseQrBillPayload, type QrBill } from "./qr-bill";
import { extractFromText, type BillFields } from "./text-extract";

export { extractFromText } from "./text-extract";
export type { BillFields, TextExtraction } from "./text-extract";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
/** Pages rendered for QR detection: the last two first, then others back to front. */
const MAX_RENDERED_PAGES = 12;
/** First pass: plain decode of a 300 dpi render. Second pass: harder decode of a cheaper render. */
const PASSES = [
  { dpi: 300, maxPixels: 12_000_000, hard: false },
  { dpi: 200, maxPixels: 4_000_000, hard: true },
] as const;
export const EXTRACTION_BUDGET_MS = 20_000;
const MAX_TEXT_CHARS = 2_000_000;

export interface BillExtraction {
  /** qr: a valid Swiss QR-bill was decoded. text: heuristics only. none: nothing found. */
  source: "qr" | "text" | "none";
  qr: QrBill | null;
  fields: BillFields;
  warnings: string[];
}

export type PdfExtractErrorCode =
  "too_large" | "not_pdf" | "encrypted" | "too_many_pages" | "unreadable";

export class PdfExtractError extends Error {
  readonly code: PdfExtractErrorCode;

  constructor(
    code: PdfExtractErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

type PdfModule = typeof import("unpdf");
type ZxingReader = typeof import("zxing-wasm/reader");
type PdfDocument = Awaited<ReturnType<PdfModule["getDocumentProxy"]>>;
type CanvasFactoryClass = Awaited<
  ReturnType<PdfModule["createIsomorphicCanvasFactory"]>
>;

interface Engine {
  pdf: PdfModule;
  zxing: ZxingReader;
  CanvasFactory: CanvasFactoryClass;
}

let enginePromise: Promise<Engine> | null = null;

/**
 * Loads pdf.js, the canvas binding and the zxing WASM module on first use.
 * The WASM binary is read from node_modules and handed to zxing directly: its
 * default would fetch it from a public CDN at runtime.
 */
function loadEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const pdf = await import("unpdf");
    const zxing = await import("zxing-wasm/reader");
    const wasmPath = createRequire(import.meta.url).resolve(
      "zxing-wasm/reader/zxing_reader.wasm",
    );
    const wasmBinary = await readFile(wasmPath);
    await zxing.prepareZXingModule({
      overrides: {
        wasmBinary: wasmBinary.buffer.slice(
          wasmBinary.byteOffset,
          wasmBinary.byteOffset + wasmBinary.byteLength,
        ) as ArrayBuffer,
      },
      fireImmediately: true,
    });
    const CanvasFactory = await pdf.createIsomorphicCanvasFactory(
      () => import("@napi-rs/canvas"),
    );
    return { pdf, zxing, CanvasFactory };
  })().catch((error) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

async function openDocument(
  engine: Engine,
  bytes: Uint8Array,
): Promise<PdfDocument> {
  try {
    // pdf.js takes ownership of the buffer, so hand it a copy.
    return await engine.pdf.getDocumentProxy(bytes.slice(), {
      CanvasFactory: engine.CanvasFactory,
    } as never);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") {
      throw new PdfExtractError("encrypted", "The PDF is password protected", {
        cause: error,
      });
    }
    throw new PdfExtractError("unreadable", "The PDF could not be read", {
      cause: error,
    });
  }
}

function pageOrder(numPages: number): number[] {
  const order: number[] = [];
  for (let p = numPages; p >= 1 && order.length < MAX_RENDERED_PAGES; p--) {
    order.push(p);
  }
  return order;
}

function checkBudget(deadline: number) {
  if (Date.now() > deadline) {
    throw new PdfExtractError(
      "unreadable",
      "Reading the PDF took too long and was stopped",
    );
  }
}

async function decodeSpcFromPage(
  engine: Engine,
  doc: PdfDocument,
  pageNumber: number,
  deadline: number,
): Promise<string[]> {
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    for (const pass of PASSES) {
      checkBudget(deadline);
      const scale = Math.min(
        pass.dpi / 72,
        Math.sqrt(pass.maxPixels / (base.width * base.height)),
      );
      const viewport = page.getViewport({ scale });
      const factory = new engine.CanvasFactory();
      const target = factory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      try {
        if (!target.context) throw new Error("Canvas context is unavailable");
        await page.render({
          canvas: target.canvas,
          canvasContext: target.context,
          viewport,
        } as never).promise;
        const image = target.context.getImageData(
          0,
          0,
          target.canvas.width,
          target.canvas.height,
        );
        const imageData = {
          data: image.data,
          width: image.width,
          height: image.height,
          colorSpace: "srgb",
        } as ImageData;
        checkBudget(deadline);
        const results = await engine.zxing.readBarcodes(imageData, {
          formats: ["QRCode"],
          maxNumberOfSymbols: 4,
          ...(pass.hard
            ? { tryHarder: true, tryRotate: true, tryInvert: true }
            : { tryHarder: false }),
        });
        const texts = results
          .map((r) => r.text)
          .filter((t) => t.startsWith("SPC"));
        if (texts.length > 0) return texts;
      } finally {
        factory.destroy(target);
      }
    }
    return [];
  } finally {
    page.cleanup();
  }
}

function emptyFields(): BillFields {
  return {
    creditorName: null,
    creditorIban: null,
    amount: null,
    currency: null,
    reference: null,
    referenceType: null,
    dueDate: null,
    invoiceNumber: null,
  };
}

function fieldsFromQr(qr: QrBill): BillFields {
  return {
    creditorName: qr.creditor.name,
    creditorIban: qr.creditorIban,
    amount: qr.amount,
    currency: qr.currency,
    reference: qr.reference,
    referenceType: qr.referenceType,
    dueDate: qr.dueDate,
    invoiceNumber: qr.invoiceNumber,
  };
}

/**
 * Extracts bill data from a PDF: Swiss QR-bill first (pages rendered in-process and
 * scanned), then text heuristics. Never throws because nothing was found; throws
 * PdfExtractError for oversized, non-PDF, encrypted or unreadable input.
 * Scanned (image-only) bills without a readable QR code yield source "none".
 */
export function extractBillFromPdf(
  bytes: Uint8Array,
  options: { budgetMs?: number } = {},
): Promise<BillExtraction> {
  return exclusive(() =>
    extractUnlocked(bytes, options.budgetMs ?? EXTRACTION_BUDGET_MS),
  );
}

let queueTail: Promise<void> = Promise.resolve();

/**
 * Runs extractions one at a time: rendering is CPU and memory heavy, and
 * concurrent uploads must queue rather than multiply peak memory.
 */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task);
  // The caller receives `run` with its outcome; the queue only needs to advance.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function extractUnlocked(
  bytes: Uint8Array,
  budgetMs: number,
): Promise<BillExtraction> {
  const deadline = Date.now() + budgetMs;
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfExtractError(
      "too_large",
      `The PDF is larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB`,
    );
  }
  if (!hasPdfHeader(bytes)) {
    throw new PdfExtractError("not_pdf", "The file is not a PDF");
  }

  const engine = await loadEngine();
  const doc = await openDocument(engine, bytes);
  const warnings: string[] = [];
  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new PdfExtractError(
        "too_many_pages",
        `The PDF has more than ${MAX_PDF_PAGES} pages`,
      );
    }
    if (doc.numPages > MAX_RENDERED_PAGES) {
      warnings.push(
        `Only the last ${MAX_RENDERED_PAGES} of ${doc.numPages} pages were scanned for a QR code`,
      );
    }

    let qr: QrBill | null = null;
    for (const pageNumber of pageOrder(doc.numPages)) {
      let payloads: string[];
      try {
        payloads = await decodeSpcFromPage(engine, doc, pageNumber, deadline);
      } catch (error) {
        warnings.push(
          `Page ${pageNumber} could not be rendered for QR detection`,
        );
        console.warn(
          "pdf page render failed",
          error instanceof Error ? error.name : "unknown",
        );
        continue;
      }
      for (const payload of payloads) {
        try {
          qr = parseQrBillPayload(payload);
          break;
        } catch (error) {
          if (!(error instanceof QrBillParseError)) throw error;
          warnings.push(
            `A QR-bill code was found on page ${pageNumber} but is invalid (${error.field})`,
          );
        }
      }
      if (qr) break;
    }

    checkBudget(deadline);
    let text = "";
    try {
      const extracted = await engine.pdf.extractText(doc, {
        mergePages: false,
      });
      text = extracted.text.join("\n").slice(0, MAX_TEXT_CHARS);
    } catch (error) {
      warnings.push("The text of the PDF could not be read");
      console.warn(
        "pdf text extraction failed",
        error instanceof Error ? error.name : "unknown",
      );
    }
    const fromText = extractFromText(text);

    if (qr) {
      warnings.push(...qr.warnings);
      const fields = fieldsFromQr(qr);
      fields.dueDate ??= fromText.fields.dueDate;
      fields.invoiceNumber ??= fromText.fields.invoiceNumber;
      return { source: "qr", qr, fields, warnings };
    }
    if (fromText.confidence === "none") {
      warnings.push("No QR-bill and no bill data were found in the PDF");
      return { source: "none", qr: null, fields: emptyFields(), warnings };
    }
    warnings.push(
      "No QR-bill was found; values were guessed from the text and need checking",
    );
    return { source: "text", qr: null, fields: fromText.fields, warnings };
  } finally {
    await doc.loadingTask.destroy();
  }
}
