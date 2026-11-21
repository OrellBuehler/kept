import { describe, expect, it } from "vitest";
import {
  matchRoute,
  runAction,
  runEndpoint,
  runLoad,
  settled,
  toJson,
  type EndpointModule,
  type Match,
  type PageModule,
  type Route,
} from "./bridge";

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

  it("matches nothing with a NUL in a segment", () => {
    expect(matchRoute(routes, "bills/a\0b")).toBeNull();
  });

  it("matches nothing with a dot segment", () => {
    for (const p of [
      "bills/.",
      "bills/..",
      "./bills",
      "bills/../bills",
      "..",
    ]) {
      expect(matchRoute(routes, p), p).toBeNull();
    }
    expect(matchRoute(routes, "bills/a.b")?.params).toEqual({ id: "a.b" });
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

describe("settled", () => {
  it("waits for promises a page returns as top-level values", async () => {
    expect(
      await settled({ now: 1, later: Promise.resolve({ tags: ["a"] }) }),
    ).toEqual({ now: 1, later: { tags: ["a"] } });
  });

  it("passes a rejection on, and handles every rejection when two promises fail", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await expect(
        settled({ a: Promise.reject(new Error("first")), b: 1 }),
      ).rejects.toThrow("first");
      await expect(
        settled({
          a: Promise.reject(new Error("one")),
          b: Promise.reject(new Error("two")),
        }),
      ).rejects.toThrow("one");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });

  it("leaves everything else as it is", async () => {
    expect(await settled([1, 2])).toEqual([1, 2]);
    expect(await settled(null)).toBeNull();
  });
});

const fakeEvent = (
  init: { url?: string; headers?: Record<string, string> } = {},
  body?: BodyInit,
) => {
  const url = new URL(init.url ?? "http://localhost/api/app/v1/pages/x");
  return {
    locals: {} as App.Locals,
    url,
    request: new Request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: init.headers,
      body,
    }),
    getClientAddress: () => "203.0.113.7",
  } as never;
};

const pageMatch = (mod: PageModule, api = "things"): Match<PageModule> => ({
  route: { ...route(api), module: async () => mod },
  params: {},
});

const json = { "content-type": "application/json" };

describe("runAction body", () => {
  const received: FormData[] = [];
  const mod: PageModule = {
    actions: {
      default: async ({ request }: { request: Request }) => {
        received.push(await request.formData());
        return { saved: true };
      },
    },
  };
  const post = async (
    body: string | undefined,
    headers: Record<string, string> = json,
  ) => {
    received.length = 0;
    const res = await runAction(
      fakeEvent({ headers }, body ?? ""),
      pageMatch(mod),
    );
    return { res, body: await res.json() };
  };

  it("refuses a body that is not JSON with 415", async () => {
    const { res, body } = await post("a=b", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(415);
    expect(body).toEqual({ message: "Content-Type must be application/json." });
    expect(received).toEqual([]);
  });

  it("refuses a declared size over the limit with 413, without reading the body", async () => {
    const { res } = await post("{}", {
      ...json,
      "content-length": "40000001",
    });
    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  it("refuses invalid base64 in a file with 400", async () => {
    const { res } = await post(
      JSON.stringify({
        f: { $file: { name: "a.pdf", type: "application/pdf", base64: "!!" } },
      }),
    );
    expect(res.status).toBe(400);
    expect(received).toEqual([]);
  });

  it("drops a __proto__ key and pollutes nothing", async () => {
    const { res } = await post(
      '{"__proto__":{"polluted":"yes"},"a":"1","b":["x","y"]}',
    );
    expect(res.status).toBe(200);
    expect([...received[0].keys()].sort()).toEqual(["a", "b", "b"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(received[0].has("polluted")).toBe(false);
  });

  it("refuses too many keys and too long a list with 400", async () => {
    const keys = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`k${i}`, "v"]),
    );
    expect((await post(JSON.stringify(keys))).res.status).toBe(400);
    const list = { l: Array.from({ length: 1001 }, () => "v") };
    expect((await post(JSON.stringify(list))).res.status).toBe(400);
    expect(received).toEqual([]);
    const fits = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, "v"]),
    );
    expect((await post(JSON.stringify(fits))).res.status).toBe(200);
    expect(
      (
        await post(
          JSON.stringify({ l: Array.from({ length: 1000 }, () => "v") }),
        )
      ).res.status,
    ).toBe(200);
  });

  it("runs the action with an empty form for an empty body", async () => {
    const { res } = await post(undefined, { "content-length": "0" });
    expect(res.status).toBe(200);
    expect([...received[0].keys()]).toEqual([]);
  });
});

describe("a failing handler", () => {
  const failing: PageModule = {
    load: () => {
      throw new Error("secret detail");
    },
    actions: {
      default: () => {
        throw new Error("secret detail");
      },
    },
  };

  it("is not turned into an answer by the bridge, and names its registry path", async () => {
    const match = pageMatch(failing, "bills/[id]");
    const loadEvent = fakeEvent();
    await expect(runLoad(loadEvent, match)).rejects.toThrow("secret detail");
    expect((loadEvent as { locals: App.Locals }).locals.appRoute).toBe(
      "bills/[id]",
    );
    const actionEvent = fakeEvent({ headers: json }, "");
    await expect(runAction(actionEvent, match)).rejects.toThrow(
      "secret detail",
    );
    expect((actionEvent as { locals: App.Locals }).locals.appRoute).toBe(
      "bills/[id]",
    );
  });
});

describe("runEndpoint", () => {
  it("does not forward the credentials of the request to the handler", async () => {
    let seen: Request | undefined;
    const mod: EndpointModule = {
      POST: async ({ request }: { request: Request }) => {
        seen = request;
        return new Response(await request.text());
      },
    };
    const match: Match<EndpointModule> = {
      route: { ...route("x"), module: async () => mod },
      params: {},
    };
    const res = await runEndpoint(
      fakeEvent(
        {
          headers: {
            authorization: "Bearer secret",
            cookie: "kept_session=secret",
            "x-other": "kept",
            "content-type": "application/json",
          },
        },
        '{"a":1}',
      ),
      match,
      "POST",
    );
    expect(await res.text()).toBe('{"a":1}');
    expect(seen?.headers.get("authorization")).toBeNull();
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(seen?.headers.get("x-other")).toBe("kept");
    expect(seen?.headers.get("origin")).toBe("http://localhost");
  });
});
