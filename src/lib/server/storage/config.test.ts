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

  it("recognises s3 but does not support it yet", () => {
    expect(() => readStorageConfig({ KEPT_STORAGE: "s3" })).toThrow(
      "not supported yet",
    );
  });
});
