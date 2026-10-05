import { describe, expect, it } from "vitest";
import {
  DRIZZLE_KIT_PIN_ENV,
  assertPinMatches,
  drizzleKitPin,
  resolveDialect,
} from "./dialect";

describe("resolveDialect", () => {
  it("is sqlite without a DATABASE_URL", () => {
    expect(resolveDialect({})).toBe("sqlite");
    expect(resolveDialect({ DATABASE_URL: "" })).toBe("sqlite");
    expect(resolveDialect({ DATABASE_URL: "  " })).toBe("sqlite");
  });

  it("is pg for postgres:// and postgresql:// urls", () => {
    expect(resolveDialect({ DATABASE_URL: "postgres://h/db" })).toBe("pg");
    expect(resolveDialect({ DATABASE_URL: "postgresql://h/db" })).toBe("pg");
    expect(resolveDialect({ DATABASE_URL: " PostgreSQL://h/db" })).toBe("pg");
  });

  it("is sqlite for any other value", () => {
    expect(resolveDialect({ DATABASE_URL: "./data/kept.db" })).toBe("sqlite");
    expect(resolveDialect({ DATABASE_URL: "file:kept.db" })).toBe("sqlite");
    expect(resolveDialect({ DATABASE_URL: "mysql://h/db" })).toBe("sqlite");
    expect(resolveDialect({ DATABASE_URL: "postgres.db" })).toBe("sqlite");
  });

  it("ignores DATABASE_PATH", () => {
    expect(resolveDialect({ DATABASE_PATH: "postgres://h/db" })).toBe("sqlite");
  });
});

describe("drizzle-kit pin", () => {
  it("is null when drizzle-kit is not running", () => {
    expect(drizzleKitPin({})).toBeNull();
    expect(drizzleKitPin({ [DRIZZLE_KIT_PIN_ENV]: "" })).toBeNull();
  });

  it("reads sqlite and pg and rejects anything else", () => {
    expect(drizzleKitPin({ [DRIZZLE_KIT_PIN_ENV]: "sqlite" })).toBe("sqlite");
    expect(drizzleKitPin({ [DRIZZLE_KIT_PIN_ENV]: "pg" })).toBe("pg");
    expect(() =>
      drizzleKitPin({ [DRIZZLE_KIT_PIN_ENV]: "postgresql" }),
    ).toThrow(/must be "sqlite" or "pg"/);
  });

  it("accepts a matching or absent pin", () => {
    expect(() => assertPinMatches("sqlite", {})).not.toThrow();
    expect(() =>
      assertPinMatches("sqlite", { [DRIZZLE_KIT_PIN_ENV]: "sqlite" }),
    ).not.toThrow();
    expect(() =>
      assertPinMatches("pg", { [DRIZZLE_KIT_PIN_ENV]: "pg" }),
    ).not.toThrow();
  });

  it("throws when the pin and the resolved dialect disagree", () => {
    expect(() =>
      assertPinMatches("sqlite", { [DRIZZLE_KIT_PIN_ENV]: "pg" }),
    ).toThrow(/generating for "pg".*resolved to "sqlite"/);
    expect(() =>
      assertPinMatches("pg", { [DRIZZLE_KIT_PIN_ENV]: "sqlite" }),
    ).toThrow(/generating for "sqlite".*resolved to "pg"/);
  });
});
