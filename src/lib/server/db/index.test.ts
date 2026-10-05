import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { first, isUniqueViolation, isUniqueViolationOn, users } from "./index";

describe("first", () => {
  const ctx = useTestDB();

  it("returns the first row of a select", async () => {
    const a = await createTestUser({ username: "alpha" });
    await createTestUser({ username: "beta" });
    const row = await first(
      ctx.db.select().from(users).orderBy(asc(users.username)).limit(1),
    );
    expect(row?.id).toBe(a.id);
  });

  it("returns undefined when nothing matches", async () => {
    const row = await first(
      ctx.db.select().from(users).where(eq(users.username, "nobody")).limit(1),
    );
    expect(row).toBeUndefined();
  });

  it("works on returning() queries", async () => {
    const row = await first(
      ctx.db
        .insert(users)
        .values({ username: "gamma", passwordHash: "x" })
        .returning({ username: users.username }),
    );
    expect(row).toEqual({ username: "gamma" });
  });
});

describe("isUniqueViolation", () => {
  const ctx = useTestDB();

  it("recognises a real unique-constraint failure", async () => {
    await createTestUser({ username: "dup" });
    let caught: unknown;
    try {
      await ctx.db.insert(users).values({ username: "dup", passwordHash: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });

  it("looks through a wrapper's cause and knows the PostgreSQL code", () => {
    const sqlite = Object.assign(new Error("x"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(isUniqueViolation(new Error("wrapped", { cause: sqlite }))).toBe(
      true,
    );
    expect(
      isUniqueViolation(new Error("pg", { cause: { code: "23505" } })),
    ).toBe(true);
  });

  it("recognises a primary-key conflict and the Bun PostgreSQL error shape", () => {
    const pk = Object.assign(new Error("x"), {
      code: "SQLITE_CONSTRAINT_PRIMARYKEY",
    });
    expect(isUniqueViolation(pk)).toBe(true);
    // Bun puts the SQLSTATE in errno (a string) and its own code in `code`.
    const bunPg = Object.assign(new Error("duplicate key"), {
      name: "PostgresError",
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "23505",
    });
    expect(isUniqueViolation(bunPg)).toBe(true);
    expect(isUniqueViolation(new Error("Failed query", { cause: bunPg }))).toBe(
      true,
    );
    const notNull = Object.assign(new Error("x"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "23502",
    });
    expect(isUniqueViolation(notNull)).toBe(false);
    // SQLite's numeric errno is not a SQLSTATE.
    expect(isUniqueViolation({ errno: 2067 })).toBe(false);
  });

  it("is false for other failures and for non-errors", async () => {
    const notNull = Object.assign(new Error("x"), {
      code: "SQLITE_CONSTRAINT_NOTNULL",
    });
    expect(isUniqueViolation(notNull)).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("SQLITE_CONSTRAINT_UNIQUE")).toBe(false);
  });
});

describe("isUniqueViolationOn", () => {
  const ctx = useTestDB();
  const username = {
    constraint: "users_username_unique",
    table: "users",
    columns: ["username"],
  };

  it("matches a real violation of that constraint only", async () => {
    await createTestUser({ username: "dup" });
    let caught: unknown;
    try {
      await ctx.db.insert(users).values({ username: "dup", passwordHash: "x" });
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolationOn(caught, username)).toBe(true);
    // SQLite identifies the constraint by its columns, PostgreSQL by its name.
    expect(
      isUniqueViolationOn(caught, {
        ...username,
        constraint: "other_unique",
        columns: ["other"],
      }),
    ).toBe(false);
  });

  it("reads SQLite's message and PostgreSQL's constraint name", () => {
    const sqlite = new Error("UNIQUE constraint failed: users.username");
    expect(
      isUniqueViolationOn(new Error("w", { cause: sqlite }), username),
    ).toBe(true);
    const pg = Object.assign(new Error("duplicate"), {
      errno: "23505",
      constraint: "users_username_unique",
    });
    expect(isUniqueViolationOn(pg, username)).toBe(true);
    expect(
      isUniqueViolationOn(
        Object.assign(pg, { constraint: "users_pkey" }),
        username,
      ),
    ).toBe(false);
    expect(isUniqueViolationOn(new Error("nope"), username)).toBe(false);
    expect(isUniqueViolationOn(undefined, username)).toBe(false);
  });
});
