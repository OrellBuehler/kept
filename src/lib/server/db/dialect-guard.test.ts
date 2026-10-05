import { describe, expect, it, vi } from "vitest";

vi.mock("./dialect", async (orig) => ({
  ...(await orig<typeof import("./dialect")>()),
  dialect: "pg",
}));

describe("openDatabase under a PostgreSQL dialect", () => {
  it("refuses to open SQLite with a schema built for PostgreSQL", async () => {
    const { openDatabase } = await import("./index");
    expect(() => openDatabase(":memory:")).toThrow(/PostgreSQL/);
  });
});
