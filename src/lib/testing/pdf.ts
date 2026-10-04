import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** All text of a PDF with runs of whitespace collapsed to one space. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({
    data: bytes.slice(),
  }).promise;
  try {
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const item of content.items) {
        if ("str" in item) parts.push(item.str, item.hasEOL ? "\n" : "");
      }
      parts.push("\n");
    }
    return parts.join("").replace(/\s+/g, " ");
  } finally {
    await doc.loadingTask.destroy();
  }
}
