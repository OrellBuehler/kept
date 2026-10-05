/**
 * The tree rules (one level, same kind as the parent) read other categories, so
 * changes take a per-user lock; otherwise two overlapping moves could each pass
 * them on PostgreSQL.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { categories, getDB } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { expectHeldBy } from "$lib/testing/locks";
import { createCategory, deleteCategory, updateCategory } from "./categories";

useTestDB();
const category = (name: string, parentId: string | null = null) => ({
  name,
  kind: "expense" as const,
  parentId,
  color: null,
  icon: null,
});

describe("categories", () => {
  it("create, update and delete take the user's category lock", async () => {
    const user = await createTestUser();
    const key = `categories:${user.id}`;
    await expectHeldBy(key, () => createCategory(user.id, category("Food")));
    const food = await createCategory(user.id, category("Meals"));
    await expectHeldBy(key, () =>
      updateCategory(user.id, food.id, category("Dining")),
    );
    await expectHeldBy(key, () => deleteCategory(user.id, food.id));
  });

  it("never nests more than one level when two moves overlap", async () => {
    for (let round = 0; round < 8; round++) {
      const user = await createTestUser();
      const a = await createCategory(user.id, category("A"));
      const b = await createCategory(user.id, category("B"));
      const c = await createCategory(user.id, category("C"));
      // A under B while B goes under C: either alone is fine, both are not.
      await Promise.allSettled([
        updateCategory(user.id, a.id, category("A", b.id)),
        updateCategory(user.id, b.id, category("B", c.id)),
      ]);
      const parents = new Map(
        (
          await getDB()
            .select()
            .from(categories)
            .where(eq(categories.userId, user.id))
        ).map((r) => [r.id, r.parentId]),
      );
      for (const [, parent] of parents) {
        if (parent !== null) expect(parents.get(parent)).toBeNull();
      }
    }
  });
});
