/**
 * Writes the fixtures that are not plain UTF-8 text. Run with:
 *   bun src/lib/testing/fixtures/csv/generate.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

const text = `Datum;Text;Betrag
01.04.2024;Bäckerei Müller;-8,40
02.04.2024;Schönenberg Öl AG;-120,00
03.04.2024;Gehalt Größe;3'000,00
`;

const latin1 = new Uint8Array(text.length);
for (let i = 0; i < text.length; i++) {
  const code = text.charCodeAt(i);
  if (code > 0xff) throw new Error("not representable in windows-1252");
  latin1[i] = code;
}
writeFileSync(join(dir, "windows-1252-umlauts.csv"), latin1);

const utf8 = new TextEncoder().encode(
  "﻿Date,Text,Amount,Currency\n2024-04-01,Café Zürich,-6.20,CHF\n2024-04-02,Sample Shop,10.00,CHF\n",
);
writeFileSync(join(dir, "utf8-bom.csv"), utf8);

const utf16 = "Date\tText\tAmount\r\n2024-04-01\tÄpfel & Birnen\t-3.10\r\n";
const buf = new Uint8Array(2 + utf16.length * 2);
buf[0] = 0xff;
buf[1] = 0xfe;
for (let i = 0; i < utf16.length; i++) {
  const c = utf16.charCodeAt(i);
  buf[2 + i * 2] = c & 0xff;
  buf[3 + i * 2] = c >> 8;
}
writeFileSync(join(dir, "utf16le-bom.csv"), buf);
