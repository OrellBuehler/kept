import { describe, expect, it } from "vitest";
import { transaction } from "$lib/server/db";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { takeOverMirror } from "./replace";

useTestDB();

describe("takeOverMirror", () => {
  it("returns false and changes nothing when the mirror is gone", async () => {
    const user = await createTestUser();
    const took = await transaction(
      async (tx) =>
        await takeOverMirror(tx, user.id, "no-such-mirror", "no-such-row"),
    );
    expect(took).toBe(false);
  });
});
