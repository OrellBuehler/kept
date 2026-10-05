import { describe, expect, it } from "vitest";
import { EXAMPLE_IBAN } from "$lib/testing/fixtures/bill-identifiers";
import { describeError, errorCode } from "./errors";

class DrizzleQueryError extends Error {
  constructor(
    message: string,
    readonly params: unknown[],
    cause: Error,
  ) {
    super(message, { cause });
    this.name = "DrizzleQueryError";
  }
}

class SQLiteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SQLiteError";
  }
}

describe("describeError", () => {
  const params = ["Rent for flat 3", "-123456", EXAMPLE_IBAN];
  const sql = "insert into transactions (description, amount) values (?, ?)";
  const driver = new SQLiteError(
    "UNIQUE constraint failed: transactions.external_id",
    "SQLITE_CONSTRAINT_UNIQUE",
  );
  const err = new DrizzleQueryError(
    `Failed query: ${sql}\nparams: ${params.join(",")}`,
    params,
    driver,
  );

  it("unwraps the cause chain to the code and never leaks message or params", () => {
    const out = describeError(err);
    expect(out).toBe(
      "DrizzleQueryError > SQLiteError [SQLITE_CONSTRAINT_UNIQUE]",
    );
    for (const p of params) expect(out).not.toContain(p);
    expect(out).not.toContain("insert into");
    expect(out).not.toContain("UNIQUE constraint failed");
  });

  it("returns only the code for errorCode", () => {
    expect(errorCode(err)).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  it("describes a Bun PostgreSQL error by SQLSTATE and constraint, never by detail", () => {
    const secret = "Key (username)=(Example Person) already exists.";
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "users_key"'),
      {
        name: "PostgresError",
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23505",
        constraint: "users_username_key",
        detail: secret,
        table: "users",
      },
    );
    const wrapped = new DrizzleQueryError(
      `Failed query: insert into "users" values ($1)\nparams: Example Person`,
      ["Example Person"],
      pg,
    );
    const out = describeError(wrapped);
    expect(out).toBe(
      "DrizzleQueryError > PostgresError [ERR_POSTGRES_SERVER_ERROR sqlstate=23505 constraint=users_username_key]",
    );
    for (const leak of ["Example Person", "detail", "insert", "duplicate"]) {
      expect(out).not.toContain(leak);
    }
    expect(errorCode(wrapped)).toBe("23505");
  });

  it("ignores a SQLSTATE or constraint that could carry free text", () => {
    const odd = Object.assign(new Error("secret"), {
      name: "PostgresError",
      errno: "contains amount 123",
      constraint: "has spaces 123",
    });
    expect(describeError(odd)).toBe("PostgresError");
  });

  it("ignores codes and names that could carry free text", () => {
    const odd = Object.assign(new Error("secret"), {
      name: "has spaces and secret=1",
      code: "contains amount 123",
    });
    expect(describeError(odd)).toBe("Error");
  });

  it("handles non-errors and cyclic causes", () => {
    expect(describeError(null)).toBe("unknown");
    expect(describeError("boom 123")).toBe("string");
    const a: { name: string; cause?: unknown } = { name: "A" };
    a.cause = a;
    expect(describeError(a).split(" > ").length).toBeLessThanOrEqual(5);
  });
});
