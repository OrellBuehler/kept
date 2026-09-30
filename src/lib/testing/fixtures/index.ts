import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads a synthetic fixture, e.g. `fixture("csv/comma-dot.csv")`. */
export function fixture(relativePath: string): Uint8Array {
  const url = new URL(relativePath, import.meta.url);
  return new Uint8Array(readFileSync(fileURLToPath(url)));
}
