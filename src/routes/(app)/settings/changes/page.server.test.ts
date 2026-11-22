import { describe, expect, it } from "vitest";
import { listChanges, runAsActor } from "$lib/server/audit";
import {
  createBill,
  getBill,
  listBills,
  updateBill,
} from "$lib/server/bills/bills";
import { createCategory } from "$lib/server/categories";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { billInput } from "$lib/testing/bills";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";
import type { PageData } from "./$types";

useTestDB();

type Form = Record<string, string | string[]>;

function act(name: keyof typeof actions, user: TestUser | null, form: Form) {
  const fn = actions[name] as (e: never) => unknown;
  return outcome(() =>
    fn(
      createTestEvent({
        user,
        form,
        url: "http://kept.test/settings/changes",
      }) as never,
    ),
  );
}

type Loaded = PageData;

async function loadPage(user: TestUser | null, query = ""): Promise<Loaded> {
  const r = await outcome(() =>
    load(
      createTestEvent({
        user,
        url: `http://kept.test/settings/changes${query}`,
      }) as never,
    ),
  );
  expect(r.type).toBe("return");
  return (r as { value: Loaded }).value;
}

const asMcp = <T>(u: TestUser, fn: () => Promise<T>, tokenId = "c1") =>
  runAsActor(
    { kind: "mcp", userId: u.id, tokenId, label: `Connection ${tokenId}` },
    fn,
  );
const asWeb = <T>(u: TestUser, fn: () => Promise<T>) =>
  runAsActor({ kind: "web", userId: u.id }, fn);

describe("settings/changes load", () => {
  it("requires a signed-in user", async () => {
    const r = await outcome(() => load(createTestEvent() as never));
    expect(r.type).not.toBe("return");
  });

  it("lists only the user's own changes, newest first, with the entity's name resolved", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await asWeb(a, () =>
      createBill(a.id, billInput({ creditorName: "First" })),
    );
    await asWeb(b, () =>
      createBill(b.id, billInput({ creditorName: "Theirs" })),
    );
    const bill = await asMcp(a, () =>
      createBill(a.id, billInput({ creditorName: "Second" })),
    );
    const data = await loadPage(a);
    expect(data.items.map((e) => e.summary)).toEqual(["Second", "First"]);
    expect(JSON.stringify(data)).not.toContain("Theirs");
    expect(data.refs.bills[bill.id]?.name).toBe("Second");
    expect(data.isFirstPage).toBe(true);
    expect(data.nextCursor).toBeNull();
    expect(data.items.every((e) => e.blocked === null)).toBe(true);
  });

  it("filters by actor kind, token, entity type and entity id", async () => {
    const u = await createTestUser();
    const web = await asWeb(u, () => createBill(u.id, billInput()));
    const one = await asMcp(u, () => createBill(u.id, billInput()), "c1");
    await asMcp(u, () => createBill(u.id, billInput()), "c2");
    await asMcp(
      u,
      () =>
        createCategory(u.id, {
          name: "Food",
          kind: "expense",
          parentId: null,
          color: null,
          icon: null,
        }),
      "c3",
    );

    const mcp = await loadPage(u, "?actor=mcp");
    expect(mcp.items).toHaveLength(3);
    expect(mcp.items.every((e) => e.actor.kind === "mcp")).toBe(true);

    const token = await loadPage(u, "?token=c1");
    expect(token.items.map((e) => e.entityId)).toEqual([one.id]);

    const type = await loadPage(u, "?type=category");
    expect(type.items.map((e) => e.entityType)).toEqual(["category"]);

    const entity = await loadPage(u, `?type=bill&entity=${web.id}`);
    expect(entity.items.map((e) => e.entityId)).toEqual([web.id]);
    expect(entity.filters).toMatchObject({ type: "bill", entity: web.id });

    const none = await loadPage(u, "?actor=api");
    expect(none.items).toEqual([]);
    expect(none.actors.map((a) => a.tokenId).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(none.actors.find((a) => a.tokenId === "c1")?.label).toBe(
      "Connection c1",
    );
  });

  it("treats an empty filter as no filter and refuses a malformed one", async () => {
    const u = await createTestUser();
    await asWeb(u, () => createBill(u.id, billInput()));
    const all = await loadPage(u, "?actor=&token=&type=&entity=");
    expect(all.items).toHaveLength(1);
    for (const bad of [
      "?actor=root",
      "?type=nope",
      "?before=x",
      "?token=" + "a".repeat(101),
    ]) {
      const r = await outcome(() =>
        load(
          createTestEvent({
            user: u,
            url: `http://kept.test/settings/changes${bad}`,
          }) as never,
        ),
      );
      expect(r).toMatchObject({ type: "error", status: 400 });
    }
  });

  it("pages with a cursor without repeating or skipping entries", async () => {
    const u = await createTestUser();
    for (let i = 0; i < 32; i++) {
      await asWeb(u, () =>
        createBill(u.id, billInput({ creditorName: `Bill ${i}` })),
      );
    }
    const first = await loadPage(u);
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const second = await loadPage(
      u,
      `?before=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.isFirstPage).toBe(false);
    expect(second.items.map((e) => e.summary)).toEqual(["Bill 1", "Bill 0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("says why an entry cannot be reverted", async () => {
    const u = await createTestUser();
    const bill = await asWeb(u, () => createBill(u.id, billInput()));
    const entry = (await listChanges(u.id)).items[0]!;
    await act("revert", u, { entryId: entry.id });
    const data = await loadPage(u);
    expect(data.items).toHaveLength(2);
    const revert = data.items[0]!;
    const original = data.items[1]!;
    expect(revert.revertOfEntryId).toBe(original.id);
    expect(revert.blocked).toMatch(/itself a revert/);
    expect(original.blocked).toMatch(/reverted already/);
    expect(original.revertedByEntryId).toBe(revert.id);
    expect(await listBills(u.id)).toEqual([]);
    expect(bill.id).toBe(original.entityId);
  });
});

describe("settings/changes revert", () => {
  it("reverts one change of the signed-in user", async () => {
    const u = await createTestUser();
    const bill = await asMcp(u, () => createBill(u.id, billInput()));
    const entry = (await listChanges(u.id)).items[0]!;
    const r = await act("revert", u, { entryId: entry.id });
    expect(r).toMatchObject({
      type: "return",
      value: { reverted: 1, warnings: [], stoppedAt: null },
    });
    await expect(getBill(u.id, bill.id)).rejects.toThrow();
  });

  it("answers a conflict with the service's message and leaves the data alone", async () => {
    const u = await createTestUser();
    const bill = await asMcp(u, () =>
      createBill(u.id, billInput({ notes: "one" })),
    );
    await asWeb(u, () =>
      updateBill(u.id, bill.id, billInput({ notes: "two" })),
    );
    const created = (await listChanges(u.id)).items.find(
      (e) => e.action === "bill.create",
    )!;
    const r = await act("revert", u, { entryId: created.id });
    expect(r.type).toBe("fail");
    const fail = r as {
      status: number;
      data: { errors: { form: string[] }; reason: string };
    };
    expect(fail.status).toBe(409);
    expect(fail.data.reason).toBe("conflict");
    expect(fail.data.errors.form[0]).toBeTruthy();
    expect((await getBill(u.id, bill.id)).notes).toBe("two");
  });

  it("refuses a change that was reverted already", async () => {
    const u = await createTestUser();
    await asMcp(u, () => createBill(u.id, billInput()));
    const entry = (await listChanges(u.id)).items[0]!;
    await act("revert", u, { entryId: entry.id });
    const again = await act("revert", u, { entryId: entry.id });
    expect(again).toMatchObject({
      type: "fail",
      status: 400,
      data: { reason: "already_reverted" },
    });
  });

  it("never reverts another user's change and says it was not found", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const bill = await asWeb(owner, () => createBill(owner.id, billInput()));
    const entry = (await listChanges(owner.id)).items[0]!;
    const r = await act("revert", other, { entryId: entry.id });
    expect(r).toMatchObject({
      type: "fail",
      data: {
        reason: "not_found",
        errors: { form: ["That change was not found."] },
      },
    });
    expect((await getBill(owner.id, bill.id)).id).toBe(bill.id);
  });

  it("rejects a missing id and a signed-out caller", async () => {
    const u = await createTestUser();
    expect(await act("revert", u, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
    expect((await act("revert", null, { entryId: "x" })).type).not.toBe(
      "return",
    );
  });
});

describe("settings/changes bulk revert", () => {
  it("reverts the chosen changes and reports how many", async () => {
    const u = await createTestUser();
    const a = await asMcp(u, () => createBill(u.id, billInput()));
    const b = await asMcp(u, () => createBill(u.id, billInput()));
    const keep = await asMcp(u, () => createBill(u.id, billInput()));
    const entries = (await listChanges(u.id)).items;
    const ids = entries
      .filter((e) => [a.id, b.id].includes(e.entityId))
      .map((e) => e.id);
    const r = await act("revertSelected", u, { entryId: ids });
    expect(r).toMatchObject({
      type: "return",
      value: { reverted: 2, stoppedAt: null },
    });
    expect((await listBills(u.id)).map((x) => x.id)).toEqual([keep.id]);
  });

  it("stops at the first change that is refused and says where and why", async () => {
    const u = await createTestUser();
    const bill = await asMcp(u, () =>
      createBill(u.id, billInput({ notes: "a" })),
    );
    await asWeb(u, () => updateBill(u.id, bill.id, billInput({ notes: "b" })));
    const other = await asMcp(u, () => createBill(u.id, billInput()));
    const entries = (await listChanges(u.id)).items;
    const create = entries.find(
      (e) => e.action === "bill.create" && e.entityId === bill.id,
    )!;
    const otherCreate = entries.find((e) => e.entityId === other.id)!;
    // Newest first: the other bill goes, then the first create is refused.
    const r = await act("revertSelected", u, {
      entryId: [create.id, otherCreate.id],
    });
    expect(r).toMatchObject({
      type: "return",
      value: {
        reverted: 1,
        stoppedAt: { entryId: create.id },
      },
    });
    const value = (r as { value: { stoppedAt: { message: string } } }).value;
    expect(value.stoppedAt.message).toBeTruthy();
    expect((await listBills(u.id)).map((x) => x.id)).toEqual([bill.id]);
  });

  it("fails when the first change is refused, and on an empty selection", async () => {
    const u = await createTestUser();
    const r = await act("revertSelected", u, { entryId: ["nope"] });
    expect(r).toMatchObject({ type: "fail", data: { reason: "not_found" } });
    expect(await act("revertSelected", u, {})).toMatchObject({
      type: "fail",
      status: 400,
    });
  });

  it("reverts everything one connection changed and nothing else", async () => {
    const u = await createTestUser();
    const mine = await asWeb(u, () => createBill(u.id, billInput()));
    await asMcp(u, () => createBill(u.id, billInput()), "c1");
    await asMcp(u, () => createBill(u.id, billInput()), "c1");
    const elsewhere = await asMcp(u, () => createBill(u.id, billInput()), "c2");
    const r = await act("revertAll", u, { tokenId: "c1" });
    expect(r).toMatchObject({
      type: "return",
      value: { reverted: 2, capped: false, stoppedAt: null },
    });
    expect((await listBills(u.id)).map((b) => b.id).sort()).toEqual(
      [mine.id, elsewhere.id].sort(),
    );
    const again = await act("revertAll", u, { tokenId: "c1" });
    expect(again).toMatchObject({ type: "fail", status: 400 });
  });

  it("does not touch another user's changes even with their token id", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const bill = await asMcp(owner, () => createBill(owner.id, billInput()));
    const r = await act("revertAll", other, { tokenId: "c1" });
    expect(r.type).toBe("fail");
    expect((await getBill(owner.id, bill.id)).id).toBe(bill.id);
  });
});
