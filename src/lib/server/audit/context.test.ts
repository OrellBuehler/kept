import { afterEach, describe, expect, it } from "vitest";
import { API_SCOPES } from "$lib/api-tokens";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import { seedBill } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent } from "$lib/testing/event";
import { seedToken } from "$lib/testing/external-api";
import { SESSION_COOKIE } from "$lib/server/auth/sessions";
import { afterCommit, transaction } from "$lib/server/db";
import {
  apiAuthFailureLimiter,
  apiTokenLimiter,
} from "$lib/server/external-api/gate";
import { startTicker } from "$lib/server/scheduling";
import { handle } from "../../../hooks.server";
import { currentActor, runAsActor, runAsSystem, type Actor } from "./context";
import { listChanges } from "./list";
import { recordChange } from "./record";

useTestDB();

afterEach(() => {
  apiTokenLimiter.reset();
  apiAuthFailureLimiter.reset();
});

async function recordAs(userId: string, actor: Actor | null) {
  const write = () =>
    transaction(async () => {
      await recordChange({
        userId,
        action: "category.create",
        entityId: crypto.randomUUID(),
        summary: "Groceries",
      });
    });
  if (actor) await runAsActor(actor, write);
  else await write();
  return (await listChanges(userId)).items[0]!;
}

describe("actor context", () => {
  it("is empty outside a request and restored after runAsActor", async () => {
    expect(currentActor()).toBeUndefined();
    const seen = await runAsActor({ kind: "web", userId: "u" }, async () => {
      await Promise.resolve();
      return currentActor();
    });
    expect(seen).toEqual({ kind: "web", userId: "u" });
    expect(currentActor()).toBeUndefined();
  });

  it("lets an inner actor override the outer one", async () => {
    await runAsActor({ kind: "web", userId: "u" }, async () => {
      await runAsActor({ kind: "mcp", userId: "u", tokenId: "c" }, async () => {
        expect(currentActor()?.kind).toBe("mcp");
      });
      expect(currentActor()?.kind).toBe("web");
    });
  });

  it("keeps concurrent requests apart", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const slow = async (actor: Actor, userId: string) =>
      await runAsActor(actor, async () => {
        await transaction(async () => {
          await new Promise((r) => setTimeout(r, 5));
          await recordChange({
            userId,
            action: "category.create",
            entityId: crypto.randomUUID(),
          });
        });
      });
    await Promise.all([
      slow({ kind: "web", userId: a.id }, a.id),
      slow({ kind: "app", userId: b.id }, b.id),
    ]);
    expect((await listChanges(a.id)).items[0]!.actor.kind).toBe("web");
    expect((await listChanges(b.id)).items[0]!.actor.kind).toBe("app");
  });

  it("survives into transaction bodies, savepoints and afterCommit hooks", async () => {
    const user = await createTestUser();
    const seen: Array<string | undefined> = [];
    await runAsActor(
      { kind: "mcp", userId: user.id, tokenId: "conn-1", label: "Assistant" },
      async () => {
        await transaction(async () => {
          seen.push(currentActor()?.kind);
          await transaction(async () => {
            seen.push(currentActor()?.kind);
          });
          afterCommit(() => {
            seen.push(currentActor()?.kind);
          });
          // Work started in the hook's own transaction keeps the actor too.
          afterCommit(async () => {
            await transaction(async () => {
              await recordChange({
                userId: user.id,
                action: "category.create",
                entityId: "hooked",
              });
            });
          });
        });
      },
    );
    expect(seen).toEqual(["mcp", "mcp", "mcp"]);
    const hooked = (await listChanges(user.id)).items[0]!;
    expect(hooked.entityId).toBe("hooked");
    expect(hooked.actor).toEqual({
      kind: "mcp",
      tokenId: "conn-1",
      label: "Assistant",
    });
  });

  it.each([
    ["web", { kind: "web" as const }, null, null],
    ["app", { kind: "app" as const }, null, null],
    [
      "api",
      { kind: "api" as const, tokenId: "t-1", label: "Home dashboard" },
      "t-1",
      "Home dashboard",
    ],
    [
      "mcp",
      { kind: "mcp" as const, tokenId: "c-1", label: "Assistant connection" },
      "c-1",
      "Assistant connection",
    ],
  ])("attributes an entry to a %s actor", async (kind, extra, token, label) => {
    const user = await createTestUser();
    const entry = await recordAs(user.id, { ...extra, userId: user.id });
    expect(entry.actor).toEqual({ kind, tokenId: token, label });
  });

  it("attributes an entry to the system when no actor is set (documented fallback)", async () => {
    const user = await createTestUser();
    const entry = await recordAs(user.id, null);
    expect(entry.actor).toEqual({ kind: "system", tokenId: null, label: null });
  });

  it("attributes background work to the system, with a label if given", async () => {
    const user = await createTestUser();
    await runAsSystem(async () => {
      await transaction(async () => {
        await recordChange({
          userId: user.id,
          action: "category.create",
          entityId: "x",
        });
      });
    }, "watch folder");
    expect((await listChanges(user.id)).items[0]!.actor).toEqual({
      kind: "system",
      tokenId: null,
      label: "watch folder",
    });
  });

  it("does not credit another user's data to the acting user", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const entry = await recordAs(b.id, { kind: "web", userId: a.id });
    expect(entry.actor.kind).toBe("system");
  });

  it("a scheduled tick is the system's even when its timer was started in a request", async () => {
    const user = await createTestUser();
    let seen: Actor | undefined;
    const stop = runAsActor({ kind: "web", userId: user.id }, () =>
      startTicker({
        name: "audit-test-tick",
        intervalMs: 60_000,
        firstRunDelayMs: 1,
        run: async () => {
          seen = currentActor();
        },
      }),
    );
    try {
      const deadline = Date.now() + 2000;
      while (!seen && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      stop();
    }
    expect(seen?.kind).toBe("system");
  });
});

describe("request pipeline", () => {
  /** Runs `handle` with a resolve that creates a bill, the way a page action would. */
  async function through(
    path: string,
    userId: string,
    init: {
      headers?: Record<string, string>;
      cookies?: Record<string, string>;
    },
  ) {
    const event = createTestEvent({ url: `http://localhost${path}`, ...init });
    const resolve = async () => {
      await seedBill(userId);
      return new Response("ok");
    };
    const res = await handle({
      event: event as never,
      resolve: resolve as never,
    });
    expect(res.status).toBe(200);
    return (await listChanges(userId)).items[0]!;
  }

  it("a signed-in browser session is web", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const entry = await through("/bills", user.id, {
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(entry.actor).toEqual({ kind: "web", tokenId: null, label: null });
  });

  it("the mobile app API is app", async () => {
    const user = await createTestUser();
    const { token } = await loginTestUser(user);
    const entry = await through("/api/app/v1/session", user.id, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(entry.actor).toEqual({ kind: "app", tokenId: null, label: null });
  });

  it("an API token is api, with the token id and its name", async () => {
    const user = await createTestUser();
    const { token, info } = await seedToken(user.id, API_SCOPES, {
      name: "Home dashboard",
    });
    const entry = await through("/api/external/v1/me", user.id, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(entry.actor).toEqual({
      kind: "api",
      tokenId: info.id,
      label: "Home dashboard",
    });
  });
});
