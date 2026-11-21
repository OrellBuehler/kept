import { describe, expect, it } from "vitest";
import { matchRoute, toJson, type Route } from "./bridge";

const route = (api: string): Route<object> => ({
  api,
  web: `/${api}`,
  routeId: `/(app)/${api}`,
  module: async () => ({}),
});

describe("matchRoute", () => {
  const routes = [route("bills"), route("bills/[id]"), route("bills/new")];

  it("matches literals and captures parameters", () => {
    expect(matchRoute(routes, "bills")?.route.api).toBe("bills");
    expect(matchRoute(routes, "bills/abc")).toMatchObject({
      route: { api: "bills/[id]" },
      params: { id: "abc" },
    });
  });

  it("prefers the literal route whatever the order", () => {
    expect(matchRoute(routes, "bills/new")?.route.api).toBe("bills/new");
    expect(matchRoute([...routes].reverse(), "bills/new")?.route.api).toBe(
      "bills/new",
    );
  });

  it("matches whole paths only", () => {
    expect(matchRoute(routes, "")).toBeNull();
    expect(matchRoute(routes, "bills/a/b")).toBeNull();
    expect(matchRoute(routes, "bill")).toBeNull();
  });
});

describe("toJson", () => {
  it("writes dates, maps and sets as plain JSON", () => {
    expect(
      JSON.parse(
        toJson({
          at: new Date("2026-01-02T03:04:05Z"),
          map: new Map([["a", 1]]),
          set: new Set(["x"]),
          gone: undefined,
        }),
      ),
    ).toEqual({ at: "2026-01-02T03:04:05.000Z", map: { a: 1 }, set: ["x"] });
  });
});
