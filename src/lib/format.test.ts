import { describe, expect, it } from "vitest";
import { daysSince, formatAgo, formatDate, todayIso } from "./format";

const DAY = 86_400_000;

describe("formatDate", () => {
  it("formats an ISO date without timezone drift", () => {
    expect(formatDate("2026-03-05")).toBe("5 Mar 2026");
  });
});

describe("todayIso", () => {
  it("uses local calendar fields", () => {
    expect(todayIso(new Date(2026, 0, 9, 23, 59))).toBe("2026-01-09");
  });
});

describe("formatAgo", () => {
  const now = Date.UTC(2026, 5, 1);
  it("counts days, then months, then years", () => {
    expect(formatAgo(now - 50 * DAY, now)).toBe("50 days ago");
    expect(formatAgo(now - 100 * DAY, now)).toBe("3 months ago");
    expect(formatAgo(now - 800 * DAY, now)).toBe("2 years ago");
  });
  it("never goes negative", () => {
    expect(daysSince(now + DAY, now)).toBe(-1);
    expect(formatAgo(now + DAY, now)).toBe("0 days ago");
  });
});
