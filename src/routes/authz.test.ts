import { describe, expect, it } from "vitest";
import { listUsers } from "$lib/server/auth/users";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import {
  createTestEvent,
  outcome,
  type TestEventOptions,
} from "$lib/testing/event";

const ev = (opts?: TestEventOptions) => createTestEvent(opts) as never;

/**
 * Authorization matrix for every server route file.
 *
 * Adding a route file (+page.server.ts, +layout.server.ts or +server.ts)
 * fails the inventory test below until it is listed here. For each entry:
 *
 *  - access "public"  : reachable without a session (list it deliberately;
 *                       its behaviour is tested in its own test file).
 *  - access "user"    : every handler must answer 401 without a user.
 *  - access "admin"   : additionally 403 for a member.
 *
 * `handlers` calls each load/action/endpoint with a fake event; add one per
 * exported handler. Routes that touch user-owned data must also get a
 * cross-user test (user A cannot read or modify user B's rows) in their own
 * test file, using createTestUser() for both users.
 */
interface Module {
  load: (event: never) => unknown;
  actions: Record<string, (event: never) => unknown>;
}
type Call = (mod: Module, event: never) => unknown;
interface Entry {
  access: "public" | "user" | "admin";
  handlers?: Record<string, Call>;
}

const matrix: Record<string, Entry> = {
  "/src/routes/api/health/+server.ts": { access: "public" },
  "/src/routes/setup/+page.server.ts": { access: "public" },
  "/src/routes/login/+page.server.ts": { access: "public" },
  "/src/routes/logout/+page.server.ts": { access: "public" },
  "/src/routes/(app)/+layout.server.ts": {
    access: "user",
    handlers: { load: (m, e) => m.load(e) },
  },
  "/src/routes/(app)/+page.server.ts": {
    access: "user",
    handlers: { load: (m, e) => m.load(e) },
  },
  "/src/routes/(app)/reports/+page.server.ts": {
    access: "user",
    handlers: { load: (m, e) => m.load(e) },
  },
  "/src/routes/(app)/reports/[kind]/+server.ts": {
    access: "user",
    handlers: {
      GET: (m, e) => (m as never as { GET: (e: never) => unknown }).GET(e),
    },
  },
  "/src/routes/(app)/settings/account/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.changePassword": (m, e) => m.actions.changePassword(e),
    },
  },
  "/src/routes/(app)/accounts/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.createInstitution": (m, e) => m.actions.createInstitution(e),
      "actions.updateInstitution": (m, e) => m.actions.updateInstitution(e),
      "actions.deleteInstitution": (m, e) => m.actions.deleteInstitution(e),
      "actions.createAccount": (m, e) => m.actions.createAccount(e),
    },
  },
  "/src/routes/(app)/accounts/[id]/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.updateAccount": (m, e) => m.actions.updateAccount(e),
      "actions.archive": (m, e) => m.actions.archive(e),
      "actions.unarchive": (m, e) => m.actions.unarchive(e),
      "actions.deleteAccount": (m, e) => m.actions.deleteAccount(e),
      "actions.addTransaction": (m, e) => m.actions.addTransaction(e),
      "actions.updateTransaction": (m, e) => m.actions.updateTransaction(e),
      "actions.deleteTransaction": (m, e) => m.actions.deleteTransaction(e),
      "actions.addSnapshot": (m, e) => m.actions.addSnapshot(e),
      "actions.deleteSnapshot": (m, e) => m.actions.deleteSnapshot(e),
    },
  },
  "/src/routes/(app)/bills/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.confirmSuggestion": (m, e) => m.actions.confirmSuggestion(e),
      "actions.dismissSuggestion": (m, e) => m.actions.dismissSuggestion(e),
    },
  },
  "/src/routes/(app)/bills/new/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.upload": (m, e) => m.actions.upload(e),
      "actions.create": (m, e) => m.actions.create(e),
    },
  },
  "/src/routes/(app)/bills/[id]/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.update": (m, e) => m.actions.update(e),
      "actions.cancel": (m, e) => m.actions.cancel(e),
      "actions.uncancel": (m, e) => m.actions.uncancel(e),
      "actions.delete": (m, e) => m.actions.delete(e),
      "actions.allocate": (m, e) => m.actions.allocate(e),
      "actions.removeAllocation": (m, e) => m.actions.removeAllocation(e),
      "actions.dismissSuggestion": (m, e) => m.actions.dismissSuggestion(e),
      "actions.undismiss": (m, e) => m.actions.undismiss(e),
      "actions.attachDocument": (m, e) => m.actions.attachDocument(e),
      "actions.reextract": (m, e) => m.actions.reextract(e),
    },
  },
  "/src/routes/(app)/bills/[id]/document/+server.ts": {
    access: "user",
    handlers: {
      GET: (m, e) => (m as never as { GET: (e: never) => unknown }).GET(e),
    },
  },
  "/src/routes/(app)/import/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.upload": (m, e) => m.actions.upload(e),
    },
  },
  "/src/routes/(app)/import/[pendingId]/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.confirm": (m, e) => m.actions.confirm(e),
      "actions.cancel": (m, e) => m.actions.cancel(e),
    },
  },
  "/src/routes/(app)/import/[pendingId]/mapping/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.save": (m, e) => m.actions.save(e),
    },
  },
  "/src/routes/(app)/accounts/[id]/imports/+page.server.ts": {
    access: "user",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.undo": (m, e) => m.actions.undo(e),
    },
  },
  "/src/routes/api/imports/[pendingId]/preview/+server.ts": {
    access: "user",
    handlers: {
      POST: (m, e) =>
        (m as unknown as { POST: (event: never) => unknown }).POST(e),
    },
  },
  "/src/routes/(app)/admin/users/+page.server.ts": {
    access: "admin",
    handlers: {
      load: (m, e) => m.load(e),
      "actions.create": (m, e) => m.actions.create(e),
      "actions.delete": (m, e) => m.actions.delete(e),
    },
  },
};

const loaders: Record<string, () => Promise<Module>> = {
  ...import.meta.glob("/src/routes/**/+page.server.ts"),
  ...import.meta.glob("/src/routes/**/+layout.server.ts"),
  ...import.meta.glob("/src/routes/**/+server.ts"),
} as Record<string, () => Promise<Module>>;

describe("route inventory", () => {
  it("every server route file is listed in the authorization matrix", () => {
    const unlisted = Object.keys(loaders).filter((f) => !(f in matrix));
    expect(unlisted, "add these routes to the matrix in authz.test.ts").toEqual(
      [],
    );
  });

  it("the matrix lists no files that no longer exist", () => {
    const stale = Object.keys(matrix).filter((f) => !(f in loaders));
    expect(stale).toEqual([]);
  });

  it("protected routes declare handlers", () => {
    for (const [file, entry] of Object.entries(matrix)) {
      if (entry.access !== "public") {
        expect(Object.keys(entry.handlers ?? {}), file).not.toHaveLength(0);
      }
    }
  });
});

const protectedCases = Object.entries(matrix)
  .filter(([, e]) => e.access !== "public")
  .flatMap(([file, entry]) =>
    Object.entries(entry.handlers ?? {}).map(
      ([name, call]) => ({ file, name, call, access: entry.access }) as const,
    ),
  );

describe("authorization", () => {
  useTestDB();

  it.each(protectedCases)(
    "$file $name rejects anonymous callers with 401",
    async ({ file, call }) => {
      const mod = await loaders[file]();
      const r = await outcome(() => call(mod, ev({ form: {} })));
      expect(r).toEqual({ type: "error", status: 401 });
    },
  );

  const adminCases = protectedCases.filter((c) => c.access === "admin");

  it.each(adminCases)(
    "$file $name rejects members with 403",
    async ({ file, call }) => {
      const member = await createTestUser();
      const mod = await loaders[file]();
      const r = await outcome(() =>
        call(
          mod,
          ev({
            user: member,
            form: { userId: member.id },
          }) as never,
        ),
      );
      expect(r).toEqual({ type: "error", status: 403 });
    },
  );

  it("a member cannot create or delete users", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    const mod =
      await loaders["/src/routes/(app)/admin/users/+page.server.ts"]();

    const created = await outcome(() =>
      mod.actions.create(
        ev({
          user: member,
          form: {
            username: "sneaky",
            password: "a-long-enough-password",
            role: "admin",
          },
        }),
      ),
    );
    const deleted = await outcome(() =>
      mod.actions.delete(ev({ user: member, form: { userId: admin.id } })),
    );
    expect(created).toEqual({ type: "error", status: 403 });
    expect(deleted).toEqual({ type: "error", status: 403 });
    expect(
      listUsers()
        .map((u) => u.id)
        .sort(),
    ).toEqual([admin.id, member.id].sort());
  });

  it("admins can use the admin routes (sanity check of the matrix setup)", async () => {
    const admin = await createTestUser({ role: "admin" });
    const mod =
      await loaders["/src/routes/(app)/admin/users/+page.server.ts"]();
    const r = await outcome(() => mod.load(ev({ user: admin })));
    expect(r.type).toBe("return");
  });
});
