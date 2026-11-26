import { describe, expect, it } from "vitest";
import { ApiError, Client, parseServerUrl } from "./client";
import { z } from "zod";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function server(answer: (seen: Seen) => { status?: number; body?: unknown }): {
  seen: Seen[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      const u = new URL(url);
      const entry: Seen = {
        method: init?.method ?? "GET",
        path: u.pathname + u.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      seen.push(entry);
      const { status = 200, body } = answer(entry);
      return new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
      });
    },
  };
}

const origin = new URL("https://kept.example.org");

describe("parseServerUrl", () => {
  it("keeps only the origin", () => {
    expect(parseServerUrl("https://kept.example.org/some/path?x=1").href).toBe(
      "https://kept.example.org/",
    );
    expect(parseServerUrl("https://kept.example.org:8443").origin).toBe(
      "https://kept.example.org:8443",
    );
  });

  it("allows plain http only on this machine", () => {
    expect(parseServerUrl("http://localhost:5311").origin).toBe(
      "http://localhost:5311",
    );
    expect(parseServerUrl("http://127.0.0.1:3000").origin).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() => parseServerUrl("http://kept.example.org")).toThrow(/https/);
  });

  it("rejects anything that is not a web address", () => {
    expect(() => parseServerUrl("kept.example.org")).toThrow(/--url/);
    expect(() => parseServerUrl("ftp://kept.example.org")).toThrow(/https/);
    expect(() => parseServerUrl("")).toThrow(/--url/);
  });
});

describe("Client", () => {
  it("signs in with JSON and sends the token as bearer afterwards", async () => {
    const s = server(({ path }) =>
      path.endsWith("/auth/login")
        ? { body: { status: "ok", token: "tok-1" } }
        : { body: { today: "2026-11-24" } },
    );
    const api = new Client(origin, s.fetch);
    await api.signIn("reviewer", "a-password");
    expect(api.signedIn).toBe(true);
    expect(await api.session()).toEqual({ today: "2026-11-24" });
    expect(s.seen[0]).toMatchObject({
      method: "POST",
      path: "/api/app/v1/auth/login",
      body: { username: "reviewer", password: "a-password" },
    });
    expect(s.seen[0]!.headers.authorization).toBeUndefined();
    expect(s.seen[0]!.headers.origin).toBe("https://kept.example.org");
    expect(s.seen[0]!.headers["content-type"]).toBe("application/json");
    expect(s.seen[1]!.headers.authorization).toBe("Bearer tok-1");
    expect(s.seen[1]!.headers.origin).toBe("https://kept.example.org");
  });

  it("refuses accounts that need a second step and keeps no session", async () => {
    const s = server(() => ({
      body: { status: "second_factor", pendingToken: "x", totp: true },
    }));
    const api = new Client(origin, s.fetch);
    await expect(api.signIn("u", "p")).rejects.toThrow(/two-step/);
    expect(api.signedIn).toBe(false);
  });

  it("reports a wrong password without repeating it", async () => {
    const s = server(() => ({
      status: 401,
      body: { message: "Invalid username or password." },
    }));
    const api = new Client(origin, s.fetch);
    const error = await api.signIn("u", "secret-value").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Invalid username or password.");
    expect(api.signedIn).toBe(false);
  });

  it("posts an action's form as JSON under the page, named by _action", async () => {
    const s = server(({ path }) =>
      path.includes("/auth/login")
        ? { body: { status: "ok", token: "t" } }
        : { body: { ok: true, data: { id: "a1" }, redirect: "/bills/b1" } },
    );
    const api = new Client(origin, s.fetch);
    await api.signIn("u", "p");
    const result = await api.action("bills/new", "create", {
      creditorName: "Example Garage",
      file: null,
    });
    expect(result).toEqual({ data: { id: "a1" }, redirect: "/bills/b1" });
    expect(s.seen[1]).toMatchObject({
      method: "POST",
      path: "/api/app/v1/pages/bills/new?_action=create",
      body: { creditorName: "Example Garage", file: null },
    });
  });

  it("turns a refused form into an error with its message and field errors only", async () => {
    const s = server(({ path }) =>
      path.includes("/auth/login")
        ? { body: { status: "ok", token: "t" } }
        : {
            status: 400,
            body: {
              ok: false,
              message: "Enter an amount.",
              data: {
                errors: { amount: ["Enter an amount."] },
                values: { amount: "private-looking value" },
              },
            },
          },
    );
    const api = new Client(origin, s.fetch);
    await api.signIn("u", "p");
    const error = await api
      .action("budgets", "createBudget", {})
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.errors).toEqual({ amount: ["Enter an amount."] });
    expect(error.message).toContain("Enter an amount.");
    expect(error.message).not.toContain("private-looking value");
  });

  it("reads a page's data through a schema and refuses an unexpected shape", async () => {
    const s = server(({ path }) =>
      path.includes("/auth/login")
        ? { body: { status: "ok", token: "t" } }
        : { body: { data: { items: [{ id: "x" }] } } },
    );
    const api = new Client(origin, s.fetch);
    await api.signIn("u", "p");
    const ok = await api.page(
      "accounts",
      z.object({ items: z.array(z.object({ id: z.string() })) }),
      { page: "2" },
    );
    expect(ok.items[0]!.id).toBe("x");
    expect(s.seen[1]!.path).toBe("/api/app/v1/pages/accounts?page=2");
    await expect(
      api.page("accounts", z.object({ items: z.number() })),
    ).rejects.toThrow(z.ZodError);
  });

  it("does not follow a page that redirects", async () => {
    const s = server(({ path }) =>
      path.includes("/auth/login")
        ? { body: { status: "ok", token: "t" } }
        : { body: { redirect: "/import" } },
    );
    const api = new Client(origin, s.fetch);
    await api.signIn("u", "p");
    await expect(api.page("x", z.unknown())).rejects.toThrow(/redirected/);
  });

  it("says when the server answers with something that is not JSON", async () => {
    const api = new Client(
      origin,
      async () => new Response("<html>", { status: 502 }),
    );
    await expect(api.signIn("u", "p")).rejects.toThrow(/JSON/);
  });

  describe("signOut", () => {
    const signedIn = (after: number, logout = 200) => {
      const s = server(({ path }) => {
        if (path.includes("/auth/login")) {
          return { body: { status: "ok", token: "t" } };
        }
        if (path.endsWith("/auth/logout"))
          return { status: logout, body: { ok: true } };
        return { status: after, body: { message: "The session has ended." } };
      });
      const api = new Client(origin, s.fetch);
      return { api, s };
    };

    it("ends the session and confirms the token no longer works", async () => {
      const { api, s } = signedIn(401);
      await api.signIn("u", "p");
      expect(await api.signOut()).toBe(true);
      expect(api.signedIn).toBe(false);
      expect(s.seen.map((x) => x.path)).toEqual([
        "/api/app/v1/auth/login",
        "/api/app/v1/auth/logout",
        "/api/app/v1/session",
      ]);
      expect(s.seen[1]!.headers.authorization).toBe("Bearer t");
      expect(s.seen[2]!.headers.authorization).toBe("Bearer t");
    });

    it("says so when the token still works", async () => {
      const { api } = signedIn(200);
      await api.signIn("u", "p");
      expect(await api.signOut()).toBe(false);
    });

    it("says so when the server refuses to end the session", async () => {
      const { api } = signedIn(401, 500);
      await api.signIn("u", "p");
      expect(await api.signOut()).toBe(false);
    });

    it("does nothing when nobody is signed in", async () => {
      const s = server(() => ({}));
      expect(await new Client(origin, s.fetch).signOut()).toBe(true);
      expect(s.seen).toEqual([]);
    });
  });
});
