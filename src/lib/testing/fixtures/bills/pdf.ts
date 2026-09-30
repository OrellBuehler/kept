import { createRequire } from "node:module";
import path from "node:path";
import type { TDocumentDefinitions, Content } from "pdfmake/interfaces";

const require = createRequire(import.meta.url);
const pdfmake = require("pdfmake");

let fontsReady = false;

function ensureFonts() {
  if (fontsReady) return;
  const dir = path.join(
    path.dirname(require.resolve("pdfmake/package.json")),
    "fonts",
    "Roboto",
  );
  pdfmake.addFonts({
    Roboto: {
      normal: path.join(dir, "Roboto-Regular.ttf"),
      bold: path.join(dir, "Roboto-Medium.ttf"),
      italics: path.join(dir, "Roboto-Italic.ttf"),
      bolditalics: path.join(dir, "Roboto-MediumItalic.ttf"),
    },
  });
  fontsReady = true;
}

export interface BillPdfOptions {
  /** Text lines placed at the top of the first page (letter body). */
  bodyLines?: string[];
  /** Number of empty filler pages before the page that carries the payment part. */
  fillerPages?: number;
  /** SPC payload rendered as QR code in a payment part at the bottom of the last page. */
  qrPayload?: string;
  /** Labels printed in the payment part. */
  paymentPart?: {
    account: string;
    reference?: string;
    amount?: string;
    currency?: string;
  };
  /** Scale factor for the QR code edge (default 130pt = 46mm). */
  qrSize?: number;
  /** Encrypts the PDF with this user password. */
  password?: string;
}

/** Generates a synthetic A4 bill PDF. Everything in it is invented. */
export async function buildBillPdf(
  options: BillPdfOptions = {},
): Promise<Uint8Array> {
  ensureFonts();
  const content: Content[] = [];
  content.push({
    text: (options.bodyLines ?? ["Example document"]).join("\n"),
    fontSize: 11,
  });

  for (let i = 0; i < (options.fillerPages ?? 0); i++) {
    content.push({ text: `Filler page ${i + 1}`, pageBreak: "before" });
  }

  if (options.qrPayload || options.paymentPart) {
    const part = options.paymentPart;
    const labels: Content[] = [{ text: "Zahlteil", bold: true, fontSize: 11 }];
    if (options.qrPayload) {
      labels.push({
        qr: options.qrPayload,
        eccLevel: "M",
        fit: options.qrSize ?? 130,
        margin: [0, 10, 0, 10],
      });
    }
    if (part) {
      labels.push({ text: `Konto / Zahlbar an\n${part.account}`, fontSize: 8 });
      if (part.reference)
        labels.push({ text: `Referenz\n${part.reference}`, fontSize: 8 });
      if (part.amount) {
        labels.push({
          text: `Währung Betrag\n${part.currency ?? "CHF"} ${part.amount}`,
          fontSize: 8,
        });
      }
    }
    content.push({
      stack: labels,
      absolutePosition: { x: 190, y: 480 },
    });
  }

  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    content,
    defaultStyle: { font: "Roboto" },
    ...(options.password
      ? { userPassword: options.password, ownerPassword: options.password }
      : {}),
  };
  return new Uint8Array(await pdfmake.createPdf(doc).getBuffer());
}
