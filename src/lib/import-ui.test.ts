import { describe, expect, it } from "vitest";
import { describeImpact } from "./import-ui";

const none = {
  transactions: 3,
  categorized: 0,
  notes: 0,
  taxYears: 0,
  deductionYears: 0,
  billAllocations: 0,
  pillar3a: 0,
  transferLinks: 0,
  mirrors: 0,
};

describe("describeImpact", () => {
  it("is empty without edits", () => {
    expect(describeImpact(none)).toEqual([]);
  });

  it("lists only the kinds that are present, with plurals", () => {
    expect(
      describeImpact({
        ...none,
        categorized: 1,
        notes: 2,
        billAllocations: 1,
        transferLinks: 3,
        mirrors: 1,
      }),
    ).toEqual([
      "1 categorized transaction",
      "2 notes",
      "1 transaction matched to bills",
      "3 transfer links",
      "1 mirrored transfer row",
    ]);
  });
});
