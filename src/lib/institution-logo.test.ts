import { describe, expect, it } from "vitest";
import { avatarClass, institutionInitials } from "./institution-logo";

describe("institution avatar", () => {
  it("derives initials", () => {
    expect(institutionInitials("Example Bank")).toBe("EB");
    expect(institutionInitials("example")).toBe("EX");
    expect(institutionInitials("  ")).toBe("?");
  });
  it("picks a stable theme colour", () => {
    expect(avatarClass("Example Bank")).toBe(avatarClass("Example Bank"));
    expect(avatarClass("x")).toMatch(/^bg-chart-[1-5]$/);
  });
});
