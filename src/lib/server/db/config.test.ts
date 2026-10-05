import { describe, expect, it } from "vitest";
import { readDatabaseConfig } from "./config";

const PASSWORD = "s3cr3t-pa55word";
const url = `postgres://kept:${PASSWORD}@db.example.invalid:5432/kept`;

function failure(env: Record<string, string | undefined>): string {
  try {
    readDatabaseConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected readDatabaseConfig to throw");
}

describe("readDatabaseConfig", () => {
  it("defaults to the SQLite file", () => {
    expect(readDatabaseConfig({})).toEqual({
      kind: "sqlite",
      path: "./data/kept.db",
    });
  });

  it("uses DATABASE_PATH", () => {
    expect(readDatabaseConfig({ DATABASE_PATH: "/data/x.db" })).toEqual({
      kind: "sqlite",
      path: "/data/x.db",
    });
  });

  it("treats an empty DATABASE_URL as unset and keeps DATABASE_PATH as given", () => {
    expect(
      readDatabaseConfig({ DATABASE_URL: "  ", DATABASE_PATH: "" }),
    ).toEqual({ kind: "sqlite", path: "" });
    expect(readDatabaseConfig({ DATABASE_URL: "" })).toEqual({
      kind: "sqlite",
      path: "./data/kept.db",
    });
  });

  it("selects PostgreSQL from a postgres:// or postgresql:// URL", () => {
    for (const scheme of ["postgres", "postgresql", "POSTGRES"]) {
      const config = readDatabaseConfig({
        DATABASE_URL: `${scheme}://u:p@h/db`,
        DATABASE_PATH: "/ignored.db",
      });
      expect(config.kind).toBe("postgres");
    }
  });

  it("applies the pool defaults", () => {
    expect(readDatabaseConfig({ DATABASE_URL: url })).toEqual({
      kind: "postgres",
      url,
      poolMax: 10,
      statementTimeoutMs: 30_000,
      transactionTimeoutMs: 60_000,
      applicationName: "kept",
      prepare: true,
    });
  });

  it("reads the tuning variables", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: url,
        KEPT_DB_POOL_MAX: "3",
        KEPT_DB_STATEMENT_TIMEOUT_MS: "0",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "5000",
        KEPT_DB_APPLICATION_NAME: "kept-prod",
        KEPT_DB_PREPARE: "false",
      }),
    ).toMatchObject({
      poolMax: 3,
      statementTimeoutMs: 0,
      transactionTimeoutMs: 5000,
      applicationName: "kept-prod",
      prepare: false,
    });
  });

  it("ignores the tuning variables with SQLite, even invalid ones", () => {
    expect(
      readDatabaseConfig({ KEPT_DB_POOL_MAX: "many", DATABASE_PATH: "a.db" }),
    ).toEqual({ kind: "sqlite", path: "a.db" });
  });

  it.each([
    ["KEPT_DB_POOL_MAX", "0"],
    ["KEPT_DB_POOL_MAX", "2.5"],
    ["KEPT_DB_POOL_MAX", "many"],
    ["KEPT_DB_STATEMENT_TIMEOUT_MS", "-1"],
    ["KEPT_DB_TRANSACTION_TIMEOUT_MS", "1.5"],
    ["KEPT_DB_APPLICATION_NAME", "has space"],
    ["KEPT_DB_APPLICATION_NAME", "x".repeat(64)],
    ["KEPT_DB_PREPARE", "yes"],
  ])("rejects %s=%s and names the variable", (name, value) => {
    const message = failure({ DATABASE_URL: url, [name]: value });
    expect(message).toContain(name);
    expect(message).toMatch(/^Invalid database configuration/);
  });

  it.each([
    "postgre://u:p@h/db",
    "postgress://u:p@h/db",
    "mysql://u:p@h/db",
    "sqlite:///tmp/x.db",
    "file:./kept.db",
    "not a url",
    "./kept.db",
  ])("refuses DATABASE_URL=%s instead of falling back to SQLite", (value) => {
    const message = failure({ DATABASE_URL: value });
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(value);
  });

  it("rejects a postgres URL that does not parse", () => {
    const message = failure({ DATABASE_URL: `postgres://${PASSWORD}@[bad/db` });
    expect(message).toContain("DATABASE_URL");
  });

  it("never echoes the password, whatever else is wrong", () => {
    for (const env of [
      { DATABASE_URL: url, KEPT_DB_POOL_MAX: "0" },
      { DATABASE_URL: url, KEPT_DB_APPLICATION_NAME: PASSWORD + " x" },
      { DATABASE_URL: `postgres://kept:${PASSWORD}@[bad/db` },
      { DATABASE_URL: `mysql://kept:${PASSWORD}@h/db` },
    ]) {
      const message = failure(env);
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain("db.example.invalid");
    }
  });
});
