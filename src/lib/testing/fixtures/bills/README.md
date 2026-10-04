# Bill fixtures

Everything here is **synthetic**. Bill PDFs are generated at test time by `pdf.ts` from the
payloads in `payloads.ts`, which use documented example IBANs and references.

`scanned-qr-bill.pdf` imitates a scanned bill: one page of `buildBillPdf({ qrPayload:
buildPayload() })`, rendered at 150 dpi, thresholded to black and white and stored as a single
CCITT Group 4 image (`/CCITTFaxDecode`, `K -1`) with no text layer. pdf.js decodes such images,
like JBIG2, with its `jbig2.wasm` module.
