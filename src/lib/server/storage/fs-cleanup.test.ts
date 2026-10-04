import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ failRm: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (control.failRm) throw new Error("write failed");
      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (control.failRm) throw new Error("cleanup failed");
      return actual.rm(...args);
    },
  };
});

import { FsBlobStore } from "./fs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kept-fs-"));
});
afterEach(() => {
  control.failRm = false;
  rmSync(dir, { recursive: true, force: true });
});

it("rethrows the original error when removing the temporary file fails too", async () => {
  control.failRm = true;
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    new FsBlobStore(dir).put("a/b", new Uint8Array([1])),
  ).rejects.toThrow("write failed");
  err.mockRestore();
});
