import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { setDocumentsRoot } from "$lib/server/bills/documents";
import { clearExtractionCache } from "$lib/server/bills/extraction";

/** Call at the top level of a test file: every test gets an empty temporary documents directory. */
export function useTestDocuments(): { readonly dir: string } {
  let dir: string | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kept-docs-"));
    setDocumentsRoot(dir);
    clearExtractionCache();
  });
  afterEach(() => {
    setDocumentsRoot(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  return {
    get dir() {
      if (!dir)
        throw new Error("useTestDocuments: no directory outside a test");
      return dir;
    },
  };
}
