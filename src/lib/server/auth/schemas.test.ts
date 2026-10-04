import { describe, expect, it } from "vitest";
import {
  USERNAME_MAX,
  loginSchema,
  passwordSchema,
  usernameSchema,
} from "./schemas";

describe("passwordSchema", () => {
  it("enforces 10..256 characters", () => {
    expect(passwordSchema.safeParse("a".repeat(9)).success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(10)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(256)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(257)).success).toBe(false);
  });

  it("does not trim", () => {
    expect(passwordSchema.parse("  spaces pad  ")).toBe("  spaces pad  ");
  });
});

describe("usernameSchema", () => {
  it("trims and lowercases", () => {
    expect(usernameSchema.parse("  Alice.Doe ")).toBe("alice.doe");
  });

  it("accepts letters, digits, dot, underscore and hyphen", () => {
    expect(usernameSchema.parse("a_b-c.9")).toBe("a_b-c.9");
  });

  it("enforces 3..32 characters", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("abc").success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(32)).success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(33)).success).toBe(false);
  });

  it("rejects other characters", () => {
    for (const bad of ["a b c", "ab@cd", "müller", "a/b", "a\\b"]) {
      expect(usernameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("loginSchema", () => {
  const base = { password: "x" };

  it("keeps normal usernames, trimmed and lowercased", () => {
    const r = loginSchema.parse({ ...base, username: "  Alice " });
    expect(r.username).toBe("alice");
  });

  it("cuts oversized usernames so they never match an account or bloat the limiter", () => {
    const r = loginSchema.parse({
      ...base,
      username: "a".repeat(100_000),
    });
    expect(r.username).toHaveLength(USERNAME_MAX + 1);
    expect(usernameSchema.safeParse(r.username).success).toBe(false);
  });

  it("an exactly maximal username is untouched", () => {
    const name = "a".repeat(USERNAME_MAX);
    expect(loginSchema.parse({ ...base, username: name }).username).toBe(name);
  });
});
