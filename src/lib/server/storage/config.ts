import { dirname, resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  KEPT_STORAGE: z.enum(["fs", "s3"]).default("fs"),
  KEPT_STORAGE_DIR: z.string().trim().min(1).optional(),
});

export interface StorageConfig {
  kind: "fs";
  /** Absolute directory below which every blob key is stored. */
  dir: string;
}

/**
 * Local files are the default, in `KEPT_STORAGE_DIR` or next to the database file, so an
 * existing data directory keeps its layout. Invalid values throw.
 */
export function readStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const parsed = configSchema.safeParse({
    KEPT_STORAGE: env.KEPT_STORAGE || undefined,
    KEPT_STORAGE_DIR: env.KEPT_STORAGE_DIR || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid storage configuration (${problems})`);
  }
  if (parsed.data.KEPT_STORAGE === "s3") {
    throw new Error(
      "Invalid storage configuration (KEPT_STORAGE: s3 is not supported yet)",
    );
  }
  if (parsed.data.KEPT_STORAGE_DIR) {
    return { kind: "fs", dir: resolve(parsed.data.KEPT_STORAGE_DIR) };
  }
  const dbPath = env.DATABASE_PATH || "./data/kept.db";
  if (dbPath === ":memory:") {
    throw new Error(
      "Invalid storage configuration (KEPT_STORAGE_DIR: required when DATABASE_PATH is :memory:)",
    );
  }
  return { kind: "fs", dir: resolve(dirname(dbPath)) };
}
