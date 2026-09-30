import { describe, expect, it } from "vitest";
import { dueHint, formatReference } from "./bill-display";

describe("dueHint", () => {
  const base = { overdue: false, status: "open" as const };
  it("describes overdue bills", () => {
    expect(dueHint({ ...base, overdue: true, dueInDays: -1 })).toBe(
      "1 day overdue",
    );
    expect(dueHint({ ...base, overdue: true, dueInDays: -12 })).toBe(
      "12 days overdue",
    );
  });
  it("describes upcoming due dates", () => {
    expect(dueHint({ ...base, dueInDays: 0 })).toBe("Due today");
    expect(dueHint({ ...base, dueInDays: 1 })).toBe("Due tomorrow");
    expect(dueHint({ ...base, dueInDays: 9 })).toBe("Due in 9 days");
  });
  it("stays quiet for settled bills and missing dates", () => {
    expect(dueHint({ ...base, status: "paid", dueInDays: 4 })).toBeNull();
    expect(dueHint({ ...base, dueInDays: null })).toBeNull();
  });
});

describe("formatReference", () => {
  it("groups a 27 digit QR reference", () => {
    expect(formatReference("000000000000000000000000000")).toBe(
      "00 00000 00000 00000 00000 00000",
    );
  });
  it("groups a creditor reference in fours", () => {
    expect(formatReference("rf12 abcd efgh")).toBe("RF12 ABCD EFGH");
  });
  it("leaves anything else alone", () => {
    expect(formatReference(" abc ")).toBe("abc");
  });
});
