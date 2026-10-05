import { describe, expect, it } from "vitest";
import { useTestDB } from "$lib/testing/db";
import { transaction } from "./index";

useTestDB();

describe("transaction lock keys", () => {
  it("a transaction (and its savepoints) may re-take its own key", async () => {
    await transaction(
      async () => {
        await transaction(async () => undefined, { lock: "a" });
      },
      { lock: "a" },
    );
  });

  it("taking a second, different key in one transaction is an error", async () => {
    await expect(
      transaction(
        async () => {
          await transaction(async () => undefined, { lock: "b" });
        },
        { lock: "a" },
      ),
    ).rejects.toThrow("two different lock keys");
  });
});
