export interface InvoiceText {
  creditor: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  amount: string;
  currency: string;
  reference: string;
  message: string;
}

const escapePdf = (text: string) =>
  text
    .replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");

/** A one-page invoice in plain PDF with the standard Helvetica font, small enough to read at a glance. */
export function buildInvoicePdf(o: InvoiceText): Uint8Array {
  const lines = [
    o.creditor,
    "Sample Street 1, Exampletown",
    "",
    `Invoice ${o.invoiceNumber}`,
    `Issue date: ${o.issueDate}`,
    `Due date: ${o.dueDate}`,
    "",
    o.message,
    "",
    `Total: ${o.currency} ${o.amount}`,
    `Payment reference: ${o.reference}`,
    "",
    "Synthetic sample document for demonstration only.",
  ];
  const text = lines
    .map((line, i) => `${i === 0 ? "" : "T* "}(${escapePdf(line)}) Tj`)
    .join("\n");
  const stream = `BT /F1 12 Tf 56 780 Td 16 TL\n${text}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
