import { createRequire } from "node:module";
import path from "node:path";
import type {
  Content,
  ContentTable,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { formatAmount, type Minor } from "$lib/money";

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
  // Reports embed no images: deny all network access and any file outside the fonts.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((file: string) =>
    path.resolve(file).startsWith(dir + path.sep),
  );
  fontsReady = true;
}

export const REPORT_LOCALE = "de-CH";

export function money(value: Minor, currency: string): string {
  return formatAmount(value, currency, REPORT_LOCALE);
}

const GRID = "#d4d4d8";
const MUTED = "#52525b";

export const reportLayout = {
  hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
    i === 0 || i === node.table.body.length ? 0 : 0.5,
  vLineWidth: () => 0,
  hLineColor: () => GRID,
  paddingTop: () => 4,
  paddingBottom: () => 4,
};

export const headerCell = (text: string, alignment?: "right"): TableCell => ({
  text,
  bold: true,
  fontSize: 9,
  color: MUTED,
  alignment,
});

export function table(
  widths: ContentTable["table"]["widths"],
  body: TableCell[][],
): ContentTable {
  return {
    table: { headerRows: 1, widths, body },
    layout: reportLayout as never,
    fontSize: 9,
  };
}

export function heading(title: string, subtitle?: string): Content[] {
  return [
    { text: title, fontSize: 18, bold: true },
    ...(subtitle
      ? [{ text: subtitle, fontSize: 10, color: MUTED, margin: [0, 2, 0, 0] }]
      : []),
  ] as Content[];
}

export function sectionTitle(text: string): Content {
  return { text, fontSize: 12, bold: true, margin: [0, 16, 0, 6] };
}

/** `YYYY-MM-DD` as a fixed instant, so the same input always yields the same file. */
export function instantOf(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * Renders a document definition to PDF bytes. Output depends only on the
 * definition: `generatedOn` (YYYY-MM-DD) replaces the wall clock everywhere.
 */
export async function renderPdf(
  definition: Omit<TDocumentDefinitions, "footer" | "info" | "defaultStyle">,
  meta: { title: string; generatedOn: string },
): Promise<Uint8Array> {
  ensureFonts();
  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [40, 40, 40, 50],
    ...definition,
    defaultStyle: { font: "Roboto", fontSize: 10 },
    info: {
      title: meta.title,
      author: "Kept",
      creator: "Kept",
      producer: "Kept",
      creationDate: instantOf(meta.generatedOn),
    },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Generated ${meta.generatedOn}`, alignment: "left" },
        { text: `Page ${page} of ${pages}`, alignment: "right" },
      ],
      fontSize: 8,
      color: MUTED,
      margin: [40, 16, 40, 0],
    }),
  };
  return new Uint8Array(await pdfmake.createPdf(doc).getBuffer());
}
