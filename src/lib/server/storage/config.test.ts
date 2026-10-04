import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readStorageConfig } from "./config";

describe("readStorageConfig", () => {
  it("defaults to local files next to the database", () => {
    expect(readStorageConfig({})).toEqual({
      kind: "fs",
      dir: resolve("./data"),
    });
    expect(readStorageConfig({ DATABASE_PATH: "/srv/kept/kept.db" })).toEqual({
      kind: "fs",
      dir: "/srv/kept",
    });
  });

  it("uses an empty DATABASE_PATH as given, like the database does", () => {
    expect(readStorageConfig({ DATABASE_PATH: "" })).toEqual({
      kind: "fs",
      dir: resolve("."),
    });
  });

  it("accepts fs explicitly and an empty value as unset", () => {
    expect(
      readStorageConfig({
        KEPT_STORAGE: "fs",
        KEPT_STORAGE_DIR: "",
        DATABASE_PATH: "/d/kept.db",
      }),
    ).toEqual({ kind: "fs", dir: "/d" });
  });

  it("lets KEPT_STORAGE_DIR override the database directory", () => {
    expect(
      readStorageConfig({
        KEPT_STORAGE_DIR: "/blobs",
        DATABASE_PATH: "/d/kept.db",
      }),
    ).toEqual({ kind: "fs", dir: "/blobs" });
  });

  it("works with an in-memory database only when a directory is given", () => {
    expect(() => readStorageConfig({ DATABASE_PATH: ":memory:" })).toThrow(
      /KEPT_STORAGE_DIR/,
    );
    expect(
      readStorageConfig({
        DATABASE_PATH: ":memory:",
        KEPT_STORAGE_DIR: "/blobs",
      }),
    ).toEqual({ kind: "fs", dir: "/blobs" });
  });

  it("rejects unknown backends", () => {
    expect(() => readStorageConfig({ KEPT_STORAGE: "ftp" })).toThrow(
      /Invalid storage configuration \(KEPT_STORAGE/,
    );
  });

  describe("s3", () => {
    const base = {
      KEPT_STORAGE: "s3",
      KEPT_S3_BUCKET: "kept",
      KEPT_S3_ACCESS_KEY_ID: "AKIDEXAMPLE0000",
      KEPT_S3_SECRET_ACCESS_KEY: "SECRETEXAMPLE0000",
    };

    it("reads the minimal configuration with defaults", () => {
      expect(readStorageConfig(base)).toEqual({
        kind: "s3",
        bucket: "kept",
        endpoint: undefined,
        region: "us-east-1",
        accessKeyId: "AKIDEXAMPLE0000",
        secretAccessKey: "SECRETEXAMPLE0000",
        prefix: "",
        virtualHostedStyle: false,
      });
    });

    it("does not need a database path or a storage directory", () => {
      expect(
        readStorageConfig({ ...base, DATABASE_PATH: ":memory:" }).kind,
      ).toBe("s3");
    });

    it("reads every option and normalises endpoint and prefix", () => {
      expect(
        readStorageConfig({
          ...base,
          KEPT_S3_ENDPOINT: "http://minio:9000/",
          KEPT_S3_REGION: "eu-central-1",
          KEPT_S3_PREFIX: " kept/prod/ ",
          KEPT_S3_VIRTUAL_HOSTED_STYLE: "true",
        }),
      ).toMatchObject({
        endpoint: "http://minio:9000",
        region: "eu-central-1",
        prefix: "kept/prod",
        virtualHostedStyle: true,
      });
    });

    it("treats empty values as unset", () => {
      expect(
        readStorageConfig({
          ...base,
          KEPT_S3_ENDPOINT: "",
          KEPT_S3_REGION: "",
          KEPT_S3_PREFIX: "",
          KEPT_S3_VIRTUAL_HOSTED_STYLE: "",
        }),
      ).toMatchObject({ region: "us-east-1", prefix: "" });
    });

    it("names every missing required variable", () => {
      expect(() => readStorageConfig({ KEPT_STORAGE: "s3" })).toThrow(
        /KEPT_S3_BUCKET.*KEPT_S3_ACCESS_KEY_ID.*KEPT_S3_SECRET_ACCESS_KEY/,
      );
    });

    it("ignores the ambient AWS and S3 variables", () => {
      expect(() =>
        readStorageConfig({
          KEPT_STORAGE: "s3",
          KEPT_S3_BUCKET: "kept",
          AWS_ACCESS_KEY_ID: "x",
          AWS_SECRET_ACCESS_KEY: "y",
          S3_ACCESS_KEY_ID: "x",
          S3_SECRET_ACCESS_KEY: "y",
        }),
      ).toThrow(/KEPT_S3_ACCESS_KEY_ID/);
    });

    it.each([
      ["KEPT_S3_ENDPOINT", "minio:9000"],
      ["KEPT_S3_ENDPOINT", "ftp://minio"],
      ["KEPT_S3_ENDPOINT", "http://user:hunter2@minio:9000"],
      ["KEPT_S3_ENDPOINT", "http://minio:9000/?x=1"],
      ["KEPT_S3_VIRTUAL_HOSTED_STYLE", "yes"],
      ["KEPT_S3_PREFIX", "/abs"],
      ["KEPT_S3_PREFIX", "a/../b"],
      ["KEPT_S3_PREFIX", "a//b"],
      ["KEPT_S3_PREFIX", "a\\b"],
    ])("rejects %s=%s", (name, value) => {
      expect(() => readStorageConfig({ ...base, [name]: value })).toThrow(
        new RegExp(`Invalid storage configuration \\(${name}`),
      );
    });

    it("never echoes the secret or other values in an error", () => {
      const secret = "very-secret-value-4711";
      let message = "";
      try {
        readStorageConfig({
          ...base,
          KEPT_S3_SECRET_ACCESS_KEY: secret,
          KEPT_S3_ENDPOINT: `http://user:${secret}@minio:9000`,
          KEPT_S3_VIRTUAL_HOSTED_STYLE: secret,
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/KEPT_S3_ENDPOINT/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("AKIDEXAMPLE0000");
    });
  });
});
