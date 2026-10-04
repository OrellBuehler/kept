import { dirname, resolve } from "node:path";
import { z } from "zod";

const s3KeyPrefix = z
  .string()
  .trim()
  .transform((v) => (v.endsWith("/") ? v.slice(0, -1) : v))
  .refine(
    (v) =>
      v === "" ||
      !(
        v.startsWith("/") ||
        v.includes("\\") ||
        v.includes("\0") ||
        v.split("/").some((s) => s === "" || s === "." || s === "..")
      ),
    "must be a relative path without empty or dot segments",
  );

const s3Endpoint = z
  .url({ protocol: /^https?$/ })
  .refine((v) => {
    if (!URL.canParse(v)) return true;
    const u = new URL(v);
    return !u.username && !u.password;
  }, "must not contain credentials")
  .refine((v) => {
    if (!URL.canParse(v)) return true;
    const u = new URL(v);
    return u.search === "" && u.hash === "";
  }, "must not contain a query or fragment");

const baseSchema = z.object({
  KEPT_STORAGE: z.enum(["fs", "s3"]).default("fs"),
  KEPT_STORAGE_DIR: z.string().trim().min(1).optional(),
});

const s3Schema = z.object({
  KEPT_S3_BUCKET: z.string().trim().min(1).optional(),
  KEPT_S3_ENDPOINT: s3Endpoint.optional(),
  KEPT_S3_REGION: z.string().trim().min(1).default("us-east-1"),
  KEPT_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  KEPT_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  KEPT_S3_PREFIX: s3KeyPrefix.default(""),
  KEPT_S3_VIRTUAL_HOSTED_STYLE: z.enum(["true", "false"]).default("false"),
});

export interface FsStorageConfig {
  kind: "fs";
  /** Absolute directory below which every blob key is stored. */
  dir: string;
}

export interface S3StorageConfig {
  kind: "s3";
  bucket: string;
  /** Service URL without the bucket, e.g. `http://minio:9000`; unset means AWS. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, without a trailing `/`; empty for none. */
  prefix: string;
  /** Bucket in the host name (AWS default) instead of the path (MinIO, Garage, SeaweedFS). */
  virtualHostedStyle: boolean;
}

export type StorageConfig = FsStorageConfig | S3StorageConfig;

const ENV_KEYS = [
  "KEPT_STORAGE",
  "KEPT_STORAGE_DIR",
  "KEPT_S3_BUCKET",
  "KEPT_S3_ENDPOINT",
  "KEPT_S3_REGION",
  "KEPT_S3_ACCESS_KEY_ID",
  "KEPT_S3_SECRET_ACCESS_KEY",
  "KEPT_S3_PREFIX",
  "KEPT_S3_VIRTUAL_HOSTED_STYLE",
] as const;

function invalid(problems: string): Error {
  return new Error(`Invalid storage configuration (${problems})`);
}

/**
 * Local files are the default, in `KEPT_STORAGE_DIR` or next to the database file, so an
 * existing data directory keeps its layout. `KEPT_STORAGE=s3` selects an S3-compatible
 * bucket; its credentials must be given as `KEPT_S3_ACCESS_KEY_ID` and
 * `KEPT_S3_SECRET_ACCESS_KEY` (the ambient `AWS_*`/`S3_*` variables are deliberately
 * ignored). Invalid values throw; messages name variables, never their values.
 */
export function readStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const raw: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) raw[key] = env[key] || undefined;
  const describeIssues = (error: z.ZodError) =>
    error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  const parsedBase = baseSchema.safeParse(raw);
  if (!parsedBase.success) throw invalid(describeIssues(parsedBase.error));
  const base = parsedBase.data;
  // Stale KEPT_S3_* variables must not stop a local-files install from starting.
  if (base.KEPT_STORAGE === "s3") {
    const parsedS3 = s3Schema.safeParse(raw);
    if (!parsedS3.success) throw invalid(describeIssues(parsedS3.error));
    const c = parsedS3.data;
    const missing = (
      [
        ["KEPT_S3_BUCKET", c.KEPT_S3_BUCKET],
        ["KEPT_S3_ACCESS_KEY_ID", c.KEPT_S3_ACCESS_KEY_ID],
        ["KEPT_S3_SECRET_ACCESS_KEY", c.KEPT_S3_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, value]) => value === undefined)
      .map(([name]) => `${name}: required when KEPT_STORAGE is s3`);
    if (missing.length > 0) throw invalid(missing.join("; "));
    return {
      kind: "s3",
      bucket: c.KEPT_S3_BUCKET!,
      endpoint: c.KEPT_S3_ENDPOINT?.replace(/\/+$/, ""),
      region: c.KEPT_S3_REGION,
      accessKeyId: c.KEPT_S3_ACCESS_KEY_ID!,
      secretAccessKey: c.KEPT_S3_SECRET_ACCESS_KEY!,
      prefix: c.KEPT_S3_PREFIX,
      virtualHostedStyle: c.KEPT_S3_VIRTUAL_HOSTED_STYLE === "true",
    };
  }
  const parsedDir = base.KEPT_STORAGE_DIR;
  if (parsedDir) {
    return { kind: "fs", dir: resolve(parsedDir) };
  }
  const dbPath = env.DATABASE_PATH ?? "./data/kept.db";
  if (dbPath === ":memory:") {
    throw invalid("KEPT_STORAGE_DIR: required when DATABASE_PATH is :memory:");
  }
  return { kind: "fs", dir: resolve(dirname(dbPath)) };
}
