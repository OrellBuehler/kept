import { describe, expect, it } from "vitest";
import { readDatabaseConfig, type PostgresDatabaseConfig } from "./config";
import {
  assertTransactionTimeoutSupported,
  connectionParams,
} from "./postgres";

function configWith(env: Record<string, string> = {}): PostgresDatabaseConfig {
  const config = readDatabaseConfig({
    DATABASE_URL: "postgres://u:p@db.example.invalid/kept",
    ...env,
  });
  if (config.kind !== "postgres") throw new Error("expected postgres");
  return config;
}

describe("connectionParams", () => {
  it("sends both timeouts when they are set", () => {
    expect(
      connectionParams(
        configWith({
          KEPT_DB_STATEMENT_TIMEOUT_MS: "1000",
          KEPT_DB_TRANSACTION_TIMEOUT_MS: "2000",
        }),
      ),
    ).toEqual({
      application_name: "kept",
      statement_timeout: 1000,
      transaction_timeout: 2000,
    });
  });

  it("omits a disabled timeout, so poolers and servers before 17 accept the startup", () => {
    const params = connectionParams(
      configWith({
        KEPT_DB_STATEMENT_TIMEOUT_MS: "0",
        KEPT_DB_TRANSACTION_TIMEOUT_MS: "0",
      }),
    );
    expect(params).toEqual({ application_name: "kept" });
    expect(Object.keys(params)).not.toContain("transaction_timeout");
  });

  it("omits only the disabled one", () => {
    expect(
      connectionParams(configWith({ KEPT_DB_TRANSACTION_TIMEOUT_MS: "0" })),
    ).toEqual({ application_name: "kept", statement_timeout: 30_000 });
  });

  it("suffixes and truncates the application name", () => {
    const params = connectionParams(
      configWith({ KEPT_DB_APPLICATION_NAME: "x".repeat(60) }),
      "-migrate",
    );
    expect(String(params.application_name)).toHaveLength(63);
  });
});

describe("assertTransactionTimeoutSupported", () => {
  const message =
    "PostgreSQL 17 or newer is required, or set KEPT_DB_TRANSACTION_TIMEOUT_MS=0";

  it("rejects a server before 17 when the transaction timeout is set", () => {
    expect(() =>
      assertTransactionTimeoutSupported(160011, configWith()),
    ).toThrow(message);
  });

  it("accepts 17 and newer", () => {
    expect(() =>
      assertTransactionTimeoutSupported(170000, configWith()),
    ).not.toThrow();
    expect(() =>
      assertTransactionTimeoutSupported(180001, configWith()),
    ).not.toThrow();
  });

  it("accepts an older server once the transaction timeout is disabled", () => {
    expect(() =>
      assertTransactionTimeoutSupported(
        140000,
        configWith({ KEPT_DB_TRANSACTION_TIMEOUT_MS: "0" }),
      ),
    ).not.toThrow();
  });
});
