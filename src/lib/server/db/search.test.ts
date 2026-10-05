import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDB } from "$lib/testing/db";
import { users } from "./index";
import { escapeLike, likeContains } from "./search";

const ctx = useTestDB();

async function matches(text: string | null, term: string): Promise<boolean> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      username: `u-${crypto.randomUUID()}`,
      passwordHash: "x",
      displayName: text,
    })
    .returning({ id: users.id });
  const found = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, user!.id), likeContains(users.displayName, term)));
  return found.length === 1;
}

describe("escapeLike", () => {
  it("escapes the backslash, percent and underscore", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});

describe("likeContains", () => {
  it("ignores case and matches anywhere", async () => {
    expect(await matches("Hello World", "WORLD")).toBe(true);
    expect(await matches("Hello World", "lo wo")).toBe(true);
    expect(await matches("Hello World", "xyz")).toBe(false);
  });

  it("takes % and _ literally", async () => {
    expect(await matches("100% sure", "0%")).toBe(true);
    expect(await matches("100 sure", "0%")).toBe(false);
    expect(await matches("a_b", "a_b")).toBe(true);
    expect(await matches("axb", "a_b")).toBe(false);
  });

  it("takes the escape character literally", async () => {
    expect(await matches("back\\slash", "\\")).toBe(true);
    expect(await matches("backslash", "\\")).toBe(false);
  });

  it("does not match NULL", async () => {
    expect(await matches(null, "a")).toBe(false);
  });
});
