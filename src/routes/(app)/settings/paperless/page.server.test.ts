import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getBill, listBills } from "$lib/server/bills/bills";
import { decryptSecret } from "$lib/server/crypto";
import {
  getDB,
  paperlessConnections,
  paperlessDocuments,
} from "$lib/server/db";
import {
  getConnectionRow,
  secretMatches,
} from "$lib/server/integrations/paperless/connection";
import { startFakePaperless } from "$lib/server/integrations/paperless/fake-server";
import {
  billPdf,
  seedConnection,
} from "$lib/server/integrations/paperless/testing";
import { createTestUser, type TestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { useTestDocuments } from "$lib/testing/documents";
import { createTestEvent, outcome } from "$lib/testing/event";
import { actions, load } from "./+page.server";

const fake = startFakePaperless();
afterAll(() => fake.stop());

let pdf: Uint8Array;
beforeAll(async () => {
  pdf = await billPdf();
}, 60_000);

type Form = Record<string, string>;
const run = (user: TestUser | null, form: Form = {}) => ({
  event: (over: object = {}) =>
    createTestEvent({
      user,
      form,
      url: "http://kept.test/settings/paperless",
      ...over,
    }) as never,
});

async function act(
  name: keyof typeof actions,
  user: TestUser | null,
  form: Form = {},
) {
  const fn = actions[name] as (e: never) => unknown;
  return outcome(() => fn(run(user, form).event()));
}
const value = (o: Awaited<ReturnType<typeof act>>) => {
  expect(o.type).toBe("return");
  return (o as { value: Record<string, unknown> }).value;
};
const failure = (o: Awaited<ReturnType<typeof act>>) => {
  expect(o.type).toBe("fail");
  return (o as { data: { errors: Record<string, string[]>; values?: Form } })
    .data;
};

async function loaded(user: TestUser) {
  const data = (await load(
    createTestEvent({
      user,
      url: "http://kept.test/settings/paperless",
    }) as never,
  )) as Record<string, unknown>;
  const lookups = data.lookups
    ? await (data.lookups as Promise<unknown>)
    : null;
  // Loosely typed on purpose: tests probe nested shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...data, lookups } as Record<string, any>;
}

describe("settings/paperless", () => {
  useTestDB();
  useTestDocuments();
  let user: TestUser;

  beforeEach(async () => {
    fake.requests = [];
    fake.docs.clear();
    fake.token = "test-token";
    fake.customFieldsStatus = 200;
    fake.serverVersion = "2.20.3";
    fake.tags = [{ id: 1, name: "Bills" }];
    fake.savedViews = [
      { id: 5, name: "Open", filter_rules: [{ rule_type: 6, value: "1" }] },
      { id: 6, name: "Search", filter_rules: [{ rule_type: 20, value: "x" }] },
    ];
    fake.customFields = [{ id: 10, name: "Amount", data_type: "monetary" }];
    user = await createTestUser();
  });

  const connect = (over: Form = {}) =>
    act("save", user, { baseUrl: fake.baseUrl, token: "test-token", ...over });

  it("load without a connection", async () => {
    const data = await loaded(user);
    expect(data).toMatchObject({
      connection: null,
      webhookUrl: null,
      recipe: null,
      lastSync: null,
      recentDocuments: [],
      uploads: [],
      lookups: null,
      minVersion: "2.16.0",
    });
    expect(data.billStatuses).toContain("open");
  });

  it("save creates the connection, returns the webhook secret once and never the token", async () => {
    const r = value(await connect({ allowInsecureTls: "on" }));
    expect(r).toMatchObject({ success: true, action: "save" });
    const secret = r.webhookSecret as string;
    expect(secret).toMatch(/^[\w-]{40,}$/);
    expect(
      (r.recipe as { action: { headers: Record<string, string> } }).action
        .headers["X-Kept-Secret"],
    ).toBe(secret);

    const row = getConnectionRow(user.id)!;
    expect(row.allowInsecureTls).toBe(true);
    expect(row.tokenEncrypted).not.toContain("test-token");
    expect(decryptSecret(row.tokenEncrypted)).toBe("test-token");
    expect(secretMatches(row, secret)).toBe(true);

    const data = await loaded(user);
    const json = JSON.stringify(data);
    for (const leaked of [
      "test-token",
      row.tokenEncrypted,
      row.webhookSecretHash,
      secret,
      "tokenEncrypted",
      "webhookSecretHash",
    ]) {
      expect(json).not.toContain(leaked);
    }
    expect(data.connection).toMatchObject({
      baseUrl: fake.baseUrl,
      enabled: true,
      billSource: null,
    });
    expect(data.connection.webhookToken).toBeUndefined();
    expect(data.webhookUrl).toBe(
      `http://kept.test/api/public/paperless/${row.webhookToken}`,
    );
    expect(data.recipe.action.headers["X-Kept-Secret"]).toBe(
      "<your webhook secret>",
    );
    expect(data.recipe.action.params).toEqual({ document_id: "{{ doc_id }}" });
  });

  it("save validates and keeps the stored token when the field is blank", async () => {
    expect(
      failure(await act("save", user, { baseUrl: "", token: "x" })).errors
        .baseUrl,
    ).toBeTruthy();
    expect(
      failure(await act("save", user, { baseUrl: "ftp://nope", token: "x" }))
        .errors.baseUrl,
    ).toBeTruthy();
    expect(
      failure(await act("save", user, { baseUrl: fake.baseUrl, token: "" }))
        .errors.token,
    ).toBeTruthy();
    expect(getConnectionRow(user.id)).toBeNull();

    await connect();
    const before = getConnectionRow(user.id)!;
    const again = value(await connect({ token: "" }));
    expect(again.webhookSecret).toBeNull();
    expect(getConnectionRow(user.id)!.tokenEncrypted).toBe(
      before.tokenEncrypted,
    );

    const bad = failure(await connect({ baseUrl: "https://u:p@host.example" }));
    expect(bad.values).toEqual({ baseUrl: "https://u:p@host.example" });
    expect(JSON.stringify(bad)).not.toContain("test-token");
  });

  it("test reports versions, and a readable failure for a wrong token", async () => {
    await connect();
    const ok = value(await act("test", user));
    expect(ok.result).toMatchObject({
      serverVersion: "2.20.3",
      apiVersion: 9,
      warnings: [],
    });

    fake.token = "rotated";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = failure(await act("test", user));
    expect(bad.errors.form[0]).toContain("token");
    const data = await loaded(user);
    expect(data.lastSync.error).toBe("unauthorized");
    expect(data.lastSync.message).toContain("token");
  });

  it("lookups list tags, views and fields; a forbidden list only affects itself", async () => {
    await connect();
    fake.customFieldsStatus = 403;
    const data = await loaded(user);
    expect(data.lookups.tags).toEqual([
      { id: 1, name: "Bills", documentCount: null },
    ]);
    expect(
      data.lookups.savedViews.map((v: { supported: boolean }) => v.supported),
    ).toEqual([true, false]);
    expect(data.lookups.customFields).toBeNull();
    expect(data.lookups.errors.customFields).toContain("permission");
    expect(data.lookups.errors.tags).toBeNull();
  });

  it("setSource stores a tag or a supported saved view and rejects the rest", async () => {
    await connect();
    value(await act("setSource", user, { kind: "tag", id: "1" }));
    expect(getConnectionRow(user.id)!.billSource).toEqual({
      kind: "tag",
      id: 1,
      label: "Bills",
    });

    value(await act("setSource", user, { kind: "saved_view", id: "5" }));
    expect(getConnectionRow(user.id)!.billSource).toEqual({
      kind: "saved_view",
      id: 5,
      label: "Open",
    });

    const unsupported = failure(
      await act("setSource", user, { kind: "saved_view", id: "6" }),
    );
    expect(unsupported.errors.id[0]).toContain("full-text");
    expect(
      failure(await act("setSource", user, { kind: "tag", id: "999" })).errors
        .id,
    ).toBeTruthy();
    expect(
      failure(await act("setSource", user, { kind: "folder", id: "1" })).errors
        .kind,
    ).toBeTruthy();
    expect(
      failure(await act("setSource", user, { kind: "tag", id: "abc" })).errors
        .id,
    ).toBeTruthy();
    expect(getConnectionRow(user.id)!.billSource).toMatchObject({
      kind: "saved_view",
      id: 5,
    });
  });

  it("setMapping stores field ids and status values, blank means unmapped", async () => {
    await connect();
    value(
      await act("setMapping", user, {
        amount: "10",
        dueDate: " 11 ",
        reference: "",
        status: "13",
        statusValue_open: "opt-open",
        statusValue_paid: "opt-paid",
        statusValue_cancelled: "",
      }),
    );
    expect(getConnectionRow(user.id)!.fieldMapping).toEqual({
      amount: 10,
      dueDate: 11,
      reference: null,
      status: 13,
      statusValues: { open: "opt-open", paid: "opt-paid" },
    });
    expect(
      failure(await act("setMapping", user, { amount: "10", dueDate: "10" }))
        .errors.form,
    ).toBeTruthy();
    expect(
      failure(await act("setMapping", user, { amount: "x" })).errors.amount,
    ).toBeTruthy();
  });

  it("rotateSecret returns a new secret once and the old one stops working", async () => {
    const first = value(await connect()).webhookSecret as string;
    const r = value(await act("rotateSecret", user));
    const row = getConnectionRow(user.id)!;
    expect(r.webhookSecret).not.toBe(first);
    expect(secretMatches(row, first)).toBe(false);
    expect(secretMatches(row, r.webhookSecret as string)).toBe(true);
    expect(JSON.stringify(await loaded(user))).not.toContain(
      r.webhookSecret as string,
    );
  });

  it("syncNow imports bills and shows the outcome in the load", async () => {
    await connect();
    const noSource = failure(await act("syncNow", user));
    expect(noSource.errors.form[0]).toContain("Choose where");

    value(await act("setSource", user, { kind: "tag", id: "1" }));
    fake.addDoc({ id: 5, original: pdf });
    const r = value(await act("syncNow", user));
    expect(r.result).toMatchObject({ imported: 1, error: null });
    expect(listBills(user.id)).toHaveLength(1);

    const data = await loaded(user);
    expect(data.recentDocuments).toHaveLength(1);
    expect(data.recentDocuments[0]).toMatchObject({
      paperlessId: 5,
      status: "imported",
      billId: listBills(user.id)[0]!.id,
    });
    expect(data.recentDocuments[0].paperlessUrl).toBe(
      `${fake.baseUrl}/documents/5/details`,
    );
    expect(data.lastSync.at).toBeGreaterThan(0);
    expect(data.lastSync.error).toBeNull();
  });

  it("toggle disables and enables, disconnect removes links but keeps the bills", async () => {
    await connect();
    value(await act("setSource", user, { kind: "tag", id: "1" }));
    fake.addDoc({ id: 5, original: pdf });
    await act("syncNow", user);
    const bill = listBills(user.id)[0]!;

    value(await act("toggle", user, { enabled: "false" }));
    expect(getConnectionRow(user.id)!.enabled).toBe(false);
    value(await act("toggle", user, { enabled: "true" }));
    expect(getConnectionRow(user.id)!.enabled).toBe(true);
    expect(
      failure(await act("toggle", user, { enabled: "maybe" })).errors.enabled,
    ).toBeTruthy();

    value(await act("disconnect", user));
    expect(getConnectionRow(user.id)).toBeNull();
    expect(getDB().select().from(paperlessDocuments).all()).toHaveLength(0);
    expect(getBill(user.id, bill.id).externalUrl).toBe(bill.externalUrl);
    expect((await loaded(user)).connection).toBeNull();
  });

  it("actions without a connection are 404s", async () => {
    for (const name of [
      "test",
      "rotateSecret",
      "syncNow",
      "disconnect",
    ] as const) {
      expect(await act(name, user), name).toEqual({
        type: "error",
        status: 404,
      });
    }
    expect(await act("toggle", user, { enabled: "true" })).toEqual({
      type: "error",
      status: 404,
    });
    expect(await act("setMapping", user, { amount: "1" })).toEqual({
      type: "error",
      status: 404,
    });
  });

  it("keeps users apart", async () => {
    const other = await createTestUser();
    seedConnection(other.id, fake);
    await connect();
    value(await act("setSource", user, { kind: "tag", id: "1" }));
    const mine = getConnectionRow(user.id)!;
    const theirs = getConnectionRow(other.id)!;

    const view = await loaded(other);
    expect(view.connection.id).toBe(theirs.id);
    expect(view.connection.id).not.toBe(mine.id);
    expect(view.recentDocuments).toEqual([]);

    value(await act("toggle", other, { enabled: "false" }));
    value(await act("rotateSecret", other));
    value(await act("disconnect", other));
    const remaining = getDB().select().from(paperlessConnections).all();
    expect(remaining.map((c) => c.userId)).toEqual([user.id]);
    expect(getConnectionRow(user.id)).toMatchObject({
      enabled: true,
      webhookSecretHash: mine.webhookSecretHash,
    });
    expect(view.webhookUrl).not.toContain(mine.webhookToken);
  });

  it("every handler needs a signed-in user", async () => {
    const o = await outcome(() =>
      load(createTestEvent({ url: "http://kept.test/" }) as never),
    );
    expect(o).toEqual({ type: "error", status: 401 });
    for (const name of Object.keys(actions) as Array<keyof typeof actions>) {
      expect(await act(name, null), name).toEqual({
        type: "error",
        status: 401,
      });
    }
  });
});
