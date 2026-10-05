import { describe, expect, it } from "vitest";
import {
  claimServer,
  dropDatabase,
  sweepableDatabases,
  TEMPLATE_DB,
  withAdmin,
} from "./pg";

describe("pg test helpers", () => {
  it("the sweep matches the prefix literally, not as a LIKE pattern", async () => {
    // `kept_testing` matches LIKE 'kept_test_%' because `_` is a wildcard.
    const bystander = "kept_testing_bystander";
    await withAdmin(async (admin) => {
      await admin.unsafe(`create database ${bystander}`);
    });
    try {
      const names = await sweepableDatabases();
      expect(names).not.toContain(bystander);
      expect(names).toContain(TEMPLATE_DB);
      expect(
        names.every((n) => n === TEMPLATE_DB || n.startsWith("kept_test_")),
      ).toBe(true);
    } finally {
      await dropDatabase(bystander);
    }
  });

  it("a second run cannot claim a server that is in use", async () => {
    // The global setup of this very run holds the run lock.
    await expect(claimServer()).rejects.toThrow(/Another test run/);
  });
});
