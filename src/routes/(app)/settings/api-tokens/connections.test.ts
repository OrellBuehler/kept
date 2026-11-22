import { afterEach, describe, expect, it } from "vitest";
import { verifyAccessToken } from "$lib/server/oauth/connections";
import {
  registrationLimiter,
  tokenFailureLimiter,
} from "$lib/server/oauth/http";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { connect } from "$lib/testing/oauth";
import { actions, load } from "./+page.server";

useTestDB();

afterEach(() => {
  registrationLimiter.reset();
  tokenFailureLimiter.reset();
});

function act(
  name: "revokeConnection" | "renameConnection",
  user: TestUser | null,
  form: Record<string, string>,
) {
  const fn = actions[name] as (e: never) => unknown;
  return outcome(() =>
    fn(
      createTestEvent({
        user,
        form,
        url: "http://kept.test/settings/api-tokens",
      }) as never,
    ),
  );
}

type Data = {
  connections: { id: string; name: string; revokedAt: number | null }[];
};

async function connectionsOf(user: TestUser) {
  const r = await outcome(() => load(createTestEvent({ user }) as never));
  return (r as { value: Data }).value.connections;
}

describe("settings/api-tokens: connected apps", () => {
  it("lists only the user's own connections, without any secret", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await connect(a, { name: "Mine" });
    const theirs = await connect(b, { name: "Theirs" });
    const mine = await connectionsOf(a);
    expect(mine.map((c) => c.name)).toEqual(["Mine"]);
    expect(JSON.stringify(mine)).not.toMatch(/kept(at|rt)_/);
    expect(JSON.stringify(mine)).not.toContain(theirs.connectionId);
  });

  it("revokes one at once, and not another user's", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = await connect(a);
    const theirs = await connect(b);

    const foreign = await act("revokeConnection", a, {
      connectionId: theirs.connectionId,
    });
    expect(foreign).toEqual({ type: "error", status: 404 });
    expect(
      await verifyAccessToken(
        theirs.accessToken,
        new URL("http://localhost/api/mcp"),
      ),
    ).toMatchObject({ ok: true });

    const done = await act("revokeConnection", a, {
      connectionId: mine.connectionId,
    });
    expect(done).toEqual({
      type: "return",
      value: { revokedConnection: true },
    });
    expect(
      await verifyAccessToken(
        mine.accessToken,
        new URL("http://localhost/api/mcp"),
      ),
    ).toEqual({ ok: false, reason: "revoked" });
    expect((await connectionsOf(a))[0]!.revokedAt).not.toBeNull();
  });

  it("renames one, for its owner only", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const mine = await connect(a);
    expect(
      await act("renameConnection", b, {
        connectionId: mine.connectionId,
        name: "Hijacked",
      }),
    ).toEqual({ type: "error", status: 404 });
    expect(
      await act("renameConnection", a, {
        connectionId: mine.connectionId,
        name: "Laptop",
      }),
    ).toEqual({ type: "return", value: { renamedConnection: true } });
    expect((await connectionsOf(a))[0]!.name).toBe("Laptop");
    const empty = await act("renameConnection", a, {
      connectionId: mine.connectionId,
      name: "  ",
    });
    expect(empty.type).toBe("fail");
  });

  it("needs a session", async () => {
    expect(await act("revokeConnection", null, { connectionId: "x" })).toEqual({
      type: "error",
      status: 401,
    });
    expect(
      await act("renameConnection", null, { connectionId: "x", name: "y" }),
    ).toEqual({ type: "error", status: 401 });
  });
});
