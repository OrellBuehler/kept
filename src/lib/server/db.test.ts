import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { first, users } from "./db";

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
