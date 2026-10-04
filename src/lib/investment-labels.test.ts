import { describe, expect, it } from "vitest";
import { splitTerms } from "./investment-labels";

describe("splitTerms", () => {
  it("prefers the exact terms", () => {
    expect(
      splitTerms({ quantity: 33333333, splitNew: 1, splitOld: 3 }),
    ).toEqual({ new: 1, old: 3 });
  });

  it("reads a plain ratio that is a whole split", () => {
    const none = { splitNew: null, splitOld: null };
    expect(splitTerms({ quantity: 200_000_000, ...none })).toEqual({
      new: 2,
      old: 1,
    });
    expect(splitTerms({ quantity: 10_000_000, ...none })).toEqual({
      new: 1,
      old: 10,
    });
    expect(splitTerms({ quantity: 150_000_000, ...none })).toBeNull();
  });
});
