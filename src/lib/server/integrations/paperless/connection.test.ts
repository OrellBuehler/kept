import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "$lib/server/crypto";
import { getDB, paperlessConnections } from "$lib/server/db";
import { LedgerError } from "$lib/server/ledger/errors";
import { createTestUser } from "$lib/testing/auth";
import { useTestDB } from "$lib/testing/db";
import { PaperlessError } from "./client";
import {
  deleteConnection,
  getConnection,
  getConnectionByWebhookToken,
  getConnectionRow,
  hashSecret,
  isOlderThan,
  listCustomFields,
  listSavedViews,
  listTags,
  resolveSource,
  rotateWebhookSecret,
  saveConnection,
  secretMatches,
  setEnabled,
  testConnection,
} from "./connection";
import { startFakePaperless } from "./fake-server";

const fake = startFakePaperless();
afterAll(() => fake.stop());

describe("connection", () => {
  useTestDB();

  beforeEach(() => {
    fake.requests = [];
    fake.token = "test-token";
    fake.serverVersion = "2.20.3";
    fake.customFieldsStatus = 200;
    fake.accepted = [9, 10];
    fake.tags = [
      { id: 1, name: "Bills" },
      { id: 2, name: "Receipts" },
    ];
    fake.savedViews = [
      {
        id: 5,
        name: "Open bills",
        filter_rules: [{ rule_type: 6, value: "1" }],
      },
      { id: 6, name: "Search", filter_rules: [{ rule_type: 20, value: "x" }] },
    ];
    fake.customFields = [
      { id: 10, name: "Amount", data_type: "monetary" },
      {
        id: 13,
        name: "State",
        data_type: "select",
        extra_data: { select_options: [{ id: "abc", label: "Open" }] },
      },
    ];
  });

  const save = (userId: string, over: Record<string, unknown> = {}) =>
    saveConnection(userId, {
      baseUrl: fake.baseUrl,
      token: "test-token",
      allowInsecureTls: false,
      ...over,
    });

  it("stores the token encrypted and the webhook secret only as a hash", async () => {
    const u = await createTestUser();
    const { connection, webhookSecret } = save(u.id);

    const row = getConnectionRow(u.id)!;
    expect(row.tokenEncrypted).not.toContain("test-token");
    expect(decryptSecret(row.tokenEncrypted)).toBe("test-token");
    expect(webhookSecret).toMatch(/^[\w-]{40,}$/);
    expect(row.webhookSecretHash).toBe(hashSecret(webhookSecret!));
    expect(JSON.stringify(row)).not.toContain(webhookSecret!);
    expect(secretMatches(row, webhookSecret!)).toBe(true);
    expect(secretMatches(row, "something else")).toBe(false);
    expect(secretMatches(row, "")).toBe(false);

    const json = JSON.stringify(connection);
    expect(json).not.toContain("test-token");
    expect(json).not.toContain(row.tokenEncrypted);
    expect(json).not.toContain(row.webhookSecretHash);
    expect(connection).toMatchObject({
      baseUrl: fake.baseUrl,
      enabled: true,
      allowInsecureTls: false,
    });
  });

  it("validates address and token", async () => {
    const u = await createTestUser();
    const fails = (over: Record<string, unknown>) => {
      try {
        save(u.id, over);
      } catch (err) {
        return err instanceof LedgerError
          ? `${err.code}:${err.field}`
          : "other";
      }
      return "none";
    };
    expect(fails({ baseUrl: "ftp://x.example" })).toBe("invalid:baseUrl");
    expect(fails({ baseUrl: "https://a:b@x.example" })).toBe("invalid:baseUrl");
    expect(fails({ token: "" })).toBe("invalid:token");
    expect(fails({ token: null })).toBe("invalid:token");
    expect(fails({ token: "has space" })).toBe("invalid:token");
    expect(fails({ token: "line\nbreak" })).toBe("invalid:token");
    expect(getConnection(u.id)).toBeNull();
  });

  it("keeps the old token when the field is left blank and replaces it otherwise", async () => {
    const u = await createTestUser();
    save(u.id);
    const first = getConnectionRow(u.id)!;

    const again = save(u.id, { token: "", allowInsecureTls: true });
    expect(again.webhookSecret).toBeNull();
    const kept = getConnectionRow(u.id)!;
    expect(kept.id).toBe(first.id);
    expect(kept.tokenEncrypted).toBe(first.tokenEncrypted);
    expect(kept.webhookToken).toBe(first.webhookToken);
    expect(kept.allowInsecureTls).toBe(true);

    save(u.id, { token: "new-token" });
    expect(decryptSecret(getConnectionRow(u.id)!.tokenEncrypted)).toBe(
      "new-token",
    );
  });

  it("rotating the secret invalidates the old one", async () => {
    const u = await createTestUser();
    const { webhookSecret } = save(u.id);
    const fresh = rotateWebhookSecret(u.id);
    const row = getConnectionRow(u.id)!;
    expect(fresh).not.toBe(webhookSecret);
    expect(secretMatches(row, webhookSecret!)).toBe(false);
    expect(secretMatches(row, fresh)).toBe(true);
  });

  it("isolates users: one connection each, distinct webhook tokens, no cross access", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    save(a.id);
    expect(getConnection(b.id)).toBeNull();
    expect(() => deleteConnection(b.id)).toThrow(LedgerError);
    expect(() => setEnabled(b.id, false)).toThrow(LedgerError);
    expect(() => rotateWebhookSecret(b.id)).toThrow(LedgerError);

    save(b.id);
    const rowA = getConnectionRow(a.id)!;
    const rowB = getConnectionRow(b.id)!;
    expect(rowA.webhookToken).not.toBe(rowB.webhookToken);
    expect(getConnectionByWebhookToken(rowA.webhookToken)!.userId).toBe(a.id);
    expect(getConnectionByWebhookToken(rowB.webhookToken)!.userId).toBe(b.id);
    expect(getConnectionByWebhookToken("nope")).toBeNull();
    deleteConnection(a.id);
    expect(getConnection(b.id)).not.toBeNull();
    expect(getDB().select().from(paperlessConnections).all()).toHaveLength(1);
  });

  it("tests the connection and records version information", async () => {
    const u = await createTestUser();
    save(u.id);
    const r = await testConnection(u.id);
    expect(r).toEqual({
      serverVersion: "2.20.3",
      apiVersion: 9,
      maxApiVersion: 10,
      warnings: [],
    });
    expect(getConnection(u.id)).toMatchObject({
      serverVersion: "2.20.3",
      apiVersion: 9,
      lastError: null,
    });
    const listRequest = fake.requests.at(-1)!;
    expect(listRequest.query.get("page_size")).toBe("1");
    expect(listRequest.query.get("fields")).toBe("id");
  });

  it("warns about servers older than 2.16 and remembers a negotiated version 10", async () => {
    const u = await createTestUser();
    save(u.id);
    fake.serverVersion = "2.10.1";
    fake.accepted = [10];
    const r = await testConnection(u.id);
    expect(r.warnings[0]).toContain("2.10.1");
    expect(r.apiVersion).toBe(10);
    expect(getConnection(u.id)!.apiVersion).toBe(10);
  });

  it("stores a failure code when the test fails", async () => {
    const u = await createTestUser();
    save(u.id);
    fake.token = "rotated";
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(testConnection(u.id)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(getConnection(u.id)!.lastError).toBe("unauthorized");
  });

  it("lists tags, saved views (flagging unsupported ones) and custom fields", async () => {
    const u = await createTestUser();
    save(u.id);
    expect((await listTags(u.id)).map((t) => t.name)).toEqual([
      "Bills",
      "Receipts",
    ]);
    const views = await listSavedViews(u.id);
    expect(views.map((v) => [v.name, v.supported])).toEqual([
      ["Open bills", true],
      ["Search", false],
    ]);
    expect(views[1]!.problem).toContain("full-text");
    const fields = await listCustomFields(u.id);
    expect(fields).toEqual([
      { id: 10, name: "Amount", dataType: "monetary", options: [] },
      {
        id: 13,
        name: "State",
        dataType: "select",
        options: [{ id: "abc", label: "Open" }],
      },
    ]);
  });

  it("surfaces a 403 on custom fields so the UI can ask for ids by hand", async () => {
    const u = await createTestUser();
    save(u.id);
    fake.customFieldsStatus = 403;
    await expect(listCustomFields(u.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(listCustomFields(u.id)).rejects.toBeInstanceOf(PaperlessError);
  });

  it("resolves tag and saved view names and reports unknown ids", async () => {
    const u = await createTestUser();
    save(u.id);
    expect((await resolveSource(u.id, "tag", 2)).label).toBe("Receipts");
    const view = await resolveSource(u.id, "saved_view", 6);
    expect(view.label).toBe("Search");
    expect(view.translation?.ok).toBe(false);
    await expect(resolveSource(u.id, "tag", 99)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("compares versions", () => {
    expect(isOlderThan("2.15.9", "2.16.0")).toBe(true);
    expect(isOlderThan("2.16.0", "2.16.0")).toBe(false);
    expect(isOlderThan("3.2.1", "2.16.0")).toBe(false);
    expect(isOlderThan("2.9.0", "2.16.0")).toBe(true);
  });
});
