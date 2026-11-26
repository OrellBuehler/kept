import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { run } from "./run";
import { Interrupted, seed } from "./seed";

vi.mock("./seed", async (original) => ({
  ...(await original<typeof import("./seed")>()),
  seed: vi.fn(),
}));

const PASSWORD = "correct horse battery";
const env = { KEPT_SEED_USERNAME: "reviewer", KEPT_SEED_PASSWORD: PASSWORD };
const argv = ["--url", "https://kept.example.org"];

interface Call {
  method: string;
  path: string;
  authorization: string | null;
}

function server(options: { logout?: number; after?: number } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({
      method: init?.method ?? "GET",
      path,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (path.endsWith("/auth/login")) {
      return Response.json({ status: "ok", token: "session-token" });
    }
    if (path.endsWith("/auth/logout")) {
      return Response.json({ ok: true }, { status: options.logout ?? 200 });
    }
    if (path.endsWith("/session")) {
      const status = calls.some((c) => c.path.endsWith("/auth/logout"))
        ? (options.after ?? 401)
        : 200;
      return Response.json({ today: "2026-11-24" }, { status });
    }
    return Response.json({ message: "unexpected" }, { status: 404 });
  };
  return { calls, fetch };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
}

const text = (lines: string[]) => lines.join("\n");

beforeEach(() => {
  vi.mocked(seed).mockReset();
});

describe("run", () => {
  it("seeds with the server's own date, signs out and checks the token is dead", async () => {
    const s = server();
    const log = io();
    const code = await run({ argv, env, fetch: s.fetch, ...log });
    expect(code).toBe(0);
    expect(seed).toHaveBeenCalledOnce();
    expect(vi.mocked(seed).mock.calls[0]![0].today).toBe("2026-11-24");
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/app/v1/auth/login",
      "GET /api/app/v1/session",
      "POST /api/app/v1/auth/logout",
      "GET /api/app/v1/session",
    ]);
    expect(s.calls[3]!.authorization).toBe("Bearer session-token");
    expect(text(log.out)).toContain("signed out: the session no longer works");
    expect(log.err).toEqual([]);
  });

  it("uses --today when given and does not ask the server", async () => {
    const s = server();
    const code = await run({
      argv: [...argv, "--today", "2026-12-24"],
      env,
      fetch: s.fetch,
      ...io(),
    });
    expect(code).toBe(0);
    expect(vi.mocked(seed).mock.calls[0]![0].today).toBe("2026-12-24");
    expect(s.calls.filter((c) => c.path.endsWith("/session"))).toHaveLength(1);
  });

  it("signs out when a step fails, and fails", async () => {
    vi.mocked(seed).mockRejectedValue(
      new ApiError("POST /x failed (400): Enter an amount.", 400),
    );
    const s = server();
    const log = io();
    const code = await run({ argv, env, fetch: s.fetch, ...log });
    expect(code).toBe(1);
    expect(text(log.err)).toContain("failed: POST /x failed (400)");
    expect(s.calls.some((c) => c.path.endsWith("/auth/logout"))).toBe(true);
    expect(text(log.out)).toContain("signed out");
  });

  it("signs out when the failure is an unexpected answer too", async () => {
    vi.mocked(seed).mockImplementation(async () => {
      throw new TypeError("boom");
    });
    const s = server();
    const log = io();
    expect(await run({ argv, env, fetch: s.fetch, ...log })).toBe(1);
    expect(text(log.err)).toContain("failed: boom");
    expect(s.calls.some((c) => c.path.endsWith("/auth/logout"))).toBe(true);
  });

  it("fails loudly when the token still works after signing out", async () => {
    const s = server({ after: 200 });
    const log = io();
    expect(await run({ argv, env, fetch: s.fetch, ...log })).toBe(1);
    expect(text(log.err)).toContain("could not be ended or still works");
    expect(text(log.out)).not.toContain("no longer works");
  });

  it("stops between steps when interrupted, signs out and exits with 130", async () => {
    vi.mocked(seed).mockImplementation(async (ctx) => {
      expect(ctx.stopped!()).toBe(false);
      process.emit("SIGINT");
      expect(ctx.stopped!()).toBe(true);
      throw new Interrupted();
    });
    const s = server();
    const log = io();
    expect(await run({ argv, env, fetch: s.fetch, ...log })).toBe(130);
    expect(text(log.err)).toContain("finishing the current step");
    expect(text(log.err)).toContain("stopped");
    expect(s.calls.some((c) => c.path.endsWith("/auth/logout"))).toBe(true);
    expect(text(log.out)).toContain("signed out");
  });

  it("never prints the password or the token", async () => {
    vi.mocked(seed).mockRejectedValue(new Error("something failed"));
    const s = server();
    const log = io();
    await run({ argv, env, fetch: s.fetch, ...log });
    const everything = text([...log.out, ...log.err]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("session-token");
  });

  it("needs the address and both credentials before it touches the network", async () => {
    for (const [args, vars, mention] of [
      [[], env, "usage"],
      [argv, {}, "KEPT_SEED_USERNAME"],
      [argv, { KEPT_SEED_USERNAME: "u" }, "KEPT_SEED_PASSWORD"],
      [[...argv, "--today", "tomorrow"], env, "usage"],
      [["--url", "http://kept.example.org"], env, "https"],
      [[...argv, "--password", "x"], env, "usage"],
    ] as const) {
      const s = server();
      const log = io();
      expect(
        await run({ argv: [...args], env: vars, fetch: s.fetch, ...log }),
      ).toBe(2);
      expect(s.calls).toEqual([]);
      expect(text(log.err)).toContain(mention);
    }
    expect(seed).not.toHaveBeenCalled();
  });

  it("does not sign out when it never signed in", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(new URL(url).pathname);
      return Response.json(
        { message: "Invalid username or password." },
        { status: 401 },
      );
    };
    const log = io();
    expect(await run({ argv, env, fetch, ...log })).toBe(1);
    expect(calls).toEqual(["/api/app/v1/auth/login"]);
    expect(text(log.err)).toContain("Invalid username or password.");
    expect(text(log.err)).not.toContain(PASSWORD);
  });
});
