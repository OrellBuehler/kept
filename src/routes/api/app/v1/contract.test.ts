import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestUser, loginTestUser } from "$lib/testing/auth";
import {
  addDays,
  OTHER_USER_MARKER,
  seedContractData,
  seedOtherUserData,
  type ContractIds,
} from "$lib/testing/app-contract";
import { useTestDB } from "$lib/testing/db";
import { createTestEvent } from "$lib/testing/event";
import { fixture } from "$lib/testing/fixtures";
import { localToday } from "$lib/server/ledger";
import { buildCamt } from "$lib/testing/fixtures/camt053/build";
import { FOREIGN_IBANS } from "$lib/testing/fixtures/bill-identifiers";
import { scanInbox, setLastScan } from "$lib/server/inbox";
import { useTestStore } from "$lib/testing/store";
import { GET as pageGet } from "./pages/[...path]/+server";
import { GET as remindersGet } from "./reminders/+server";
import { GET as serverGet } from "./server/+server";
import { GET as sessionGet } from "./session/+server";

/*
 * The JSON of every bridged page is a contract with the released mobile apps.
 * `src/lib/testing/fixtures/app-contract/*.json` holds one capture per page (the exact response body
 * of GET /api/app/v1/pages/…, from the dataset of src/lib/testing/app-contract.ts).
 * The apps' DTOs are written and tested against these files.
 *
 * This test captures every page again and compares the SHAPE with the committed
 * file: ids, dates and amounts differ on each run, so only key paths and JSON
 * types are compared. A key that disappears or changes type fails; a new key is
 * an additive change and passes. After an intended, additive change:
 *
 *   UPDATE_APP_CONTRACT=1 bun run test src/routes/api/app/v1/contract.test.ts
 */

// --- shape comparison ---------------------------------------------------------

type JsonType = "boolean" | "number" | "string" | "array" | "object";

/** The merged shape of every value seen at one JSON path. */
interface Shape {
  /** Non-null types seen; empty when only null (or nothing) was seen. */
  types: Set<JsonType>;
  props: Map<string, Shape>;
  /** Merged shape of the elements of all arrays seen. */
  items: Shape | null;
}

const empty = (): Shape => ({
  types: new Set(),
  props: new Map(),
  items: null,
});

function merge(into: Shape, from: Shape): void {
  for (const t of from.types) into.types.add(t);
  for (const [key, child] of from.props) {
    const existing = into.props.get(key);
    if (existing) merge(existing, child);
    else into.props.set(key, child);
  }
  if (from.items) {
    if (into.items) merge(into.items, from.items);
    else into.items = from.items;
  }
}

/**
 * Paths: `data.accounts[].id` (an array adds `[]`, no index). An object whose keys are
 * ids (or currencies) is declared by `<path>.*`: its values are merged into one shape
 * instead of comparing the keys.
 */
function shapeOf(
  value: unknown,
  mapPaths: readonly string[] = [],
  path = "",
): Shape {
  const maps = new Set(mapPaths.map((p) => p.replace(/\.\*$/, "")));
  return shapeAt(value, path, maps);
}

function shapeAt(value: unknown, path: string, maps: Set<string>): Shape {
  const shape = empty();
  if (value === null || value === undefined) return shape;
  if (Array.isArray(value)) {
    shape.types.add("array");
    for (const element of value) {
      shape.items ??= empty();
      merge(shape.items, shapeAt(element, `${path}[]`, maps));
    }
    return shape;
  }
  if (typeof value === "object") {
    shape.types.add("object");
    const entries = Object.entries(value);
    if (maps.has(path)) {
      const values = empty();
      for (const [, v] of entries) merge(values, shapeAt(v, `${path}.*`, maps));
      if (entries.length > 0) shape.props.set("*", values);
      return shape;
    }
    for (const [key, v] of entries) {
      shape.props.set(
        key,
        shapeAt(v, path === "" ? key : `${path}.${key}`, maps),
      );
    }
    return shape;
  }
  if (typeof value === "string") shape.types.add("string");
  else if (typeof value === "number") shape.types.add("number");
  else if (typeof value === "boolean") shape.types.add("boolean");
  else throw new Error(`not JSON: ${typeof value} at ${path || "(root)"}`);
  return shape;
}

interface ShapeProblem {
  path: string;
  message: string;
}

function walk(
  committed: Shape,
  fresh: Shape,
  path: string,
  out: ShapeProblem[],
): void {
  const at = path === "" ? "(root)" : path;
  // Null (or an empty array) on either side says nothing about the type.
  if (committed.types.size === 0 || fresh.types.size === 0) return;
  for (const type of fresh.types) {
    if (!committed.types.has(type)) {
      out.push({
        path: at,
        message: `was ${[...committed.types].join(" | ")}, is now ${[...fresh.types].join(" | ")}`,
      });
      return;
    }
  }
  if (committed.types.has("object") && fresh.types.has("object")) {
    for (const [key, child] of committed.props) {
      const now = fresh.props.get(key);
      const childPath =
        key === "*" ? `${path}.*` : path === "" ? key : `${path}.${key}`;
      // An id-keyed map with no entries says nothing about its values.
      if (!now) {
        if (key !== "*") out.push({ path: childPath, message: "was removed" });
      } else walk(child, now, childPath, out);
    }
  }
  if (committed.items && fresh.items) {
    walk(committed.items, fresh.items, `${path}[]`, out);
  }
}

/**
 * What a released app could no longer read: every key path of `committed` must
 * still be there with the same JSON type. `null` and empty arrays are compatible
 * with anything; keys that are new in `fresh` are fine.
 */
function shapeProblems(
  committed: unknown,
  fresh: unknown,
  mapPaths: readonly string[] = [],
): ShapeProblem[] {
  const out: ShapeProblem[] = [];
  walk(shapeOf(committed, mapPaths), shapeOf(fresh, mapPaths), "", out);
  return out;
}

const UPDATE_HINT =
  "If the change is intended and additive, regenerate the fixtures with: " +
  "UPDATE_APP_CONTRACT=1 bun run test src/routes/api/app/v1/contract.test.ts";

/** The failure messages of one fixture (none when the fresh capture is compatible). */
function contractProblems(
  file: string,
  committedText: string | null,
  fresh: unknown,
  mapPaths: readonly string[] = [],
): string[] {
  if (committedText === null) {
    return [`${file}: the fixture file does not exist. ${UPDATE_HINT}`];
  }
  let committed: unknown;
  try {
    committed = JSON.parse(committedText);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return [`${file}: the fixture is not valid JSON. ${UPDATE_HINT}`];
  }
  return shapeProblems(committed, fresh, mapPaths).map(
    (p) => `${file}: ${p.path} ${p.message}. ${UPDATE_HINT}`,
  );
}

describe("contract: shape comparison", () => {
  const problems = (committed: unknown, fresh: unknown, maps: string[] = []) =>
    shapeProblems(committed, fresh, maps).map((p) => `${p.path} ${p.message}`);

  it("accepts identical shapes with different values", () => {
    expect(
      problems(
        { data: { id: "a", n: 1, ok: true, list: [{ x: 1 }] } },
        { data: { id: "b", n: 99, ok: false, list: [{ x: 7 }, { x: 8 }] } },
      ),
    ).toEqual([]);
  });

  it("fails a removed key and names its path", () => {
    expect(
      problems({ data: { a: 1, b: { c: "x" } } }, { data: { a: 1, b: {} } }),
    ).toEqual(["data.b.c was removed"]);
    expect(problems({ data: { a: 1 } }, {})).toEqual(["data was removed"]);
  });

  it("fails a key that is gone from an array element", () => {
    expect(
      problems(
        { data: { list: [{ id: "a", amount: 5 }] } },
        { data: { list: [{ id: "b" }] } },
      ),
    ).toEqual(["data.list[].amount was removed"]);
  });

  it("fails a retyped key, in both directions and for containers", () => {
    expect(problems({ a: 1 }, { a: "1" })).toEqual([
      "a was number, is now string",
    ]);
    expect(problems({ a: "x" }, { a: 5 })).toEqual([
      "a was string, is now number",
    ]);
    expect(problems({ a: true }, { a: "true" })).toEqual([
      "a was boolean, is now string",
    ]);
    expect(problems({ a: { b: 1 } }, { a: [1] })).toEqual([
      "a was object, is now array",
    ]);
    expect(problems({ a: [1] }, { a: { b: 1 } })).toEqual([
      "a was array, is now object",
    ]);
    expect(problems({ list: [{ n: 1 }] }, { list: [{ n: "1" }] })).toEqual([
      "list[].n was number, is now string",
    ]);
    expect(problems([1], { a: 1 })).toEqual([
      "(root) was array, is now object",
    ]);
  });

  it("lets new keys through", () => {
    expect(
      problems({ data: { a: 1 } }, { data: { a: 2, b: "new", c: { d: [1] } } }),
    ).toEqual([]);
  });

  it("treats null as compatible with anything, on either side", () => {
    expect(problems({ a: null }, { a: "text" })).toEqual([]);
    expect(problems({ a: "text" }, { a: null })).toEqual([]);
    expect(problems({ a: { b: 1 } }, { a: null })).toEqual([]);
    expect(problems({ a: null }, { a: { b: 1 } })).toEqual([]);
    expect(problems({ a: null }, { a: null })).toEqual([]);
  });

  it("still needs a null key to be present", () => {
    expect(problems({ a: null }, {})).toEqual(["a was removed"]);
  });

  it("compares arrays by the merged shape of all their elements", () => {
    // Optional keys of different elements add up.
    expect(
      problems({ l: [{ a: 1 }, { b: "x" }] }, { l: [{ a: 1, b: "y" }] }),
    ).toEqual([]);
    expect(problems({ l: [{ a: 1 }, { b: "x" }] }, { l: [{ a: 1 }] })).toEqual([
      "l[].b was removed",
    ]);
    // A null in one element does not hide the type of another.
    expect(
      problems({ l: [{ a: null }, { a: 1 }] }, { l: [{ a: "x" }] }),
    ).toEqual(["l[].a was number, is now string"]);
    expect(problems({ l: [{ a: 1 }] }, { l: [{ a: null }, { a: 2 }] })).toEqual(
      [],
    );
    expect(problems({ l: [[1, 2], [3]] }, { l: [["x"]] })).toEqual([
      "l[][] was number, is now string",
    ]);
  });

  it("treats an empty array as compatible with anything", () => {
    expect(problems({ l: [] }, { l: [{ a: 1 }] })).toEqual([]);
    expect(problems({ l: [{ a: 1 }] }, { l: [] })).toEqual([]);
    expect(problems({ l: [] }, { l: [] })).toEqual([]);
    // It is still an array: only its elements are open.
    expect(problems({ l: [] }, { l: "text" })).toEqual([
      "l was array, is now string",
    ]);
    expect(problems({ l: [{ a: 1 }] }, { l: "text" })).toEqual([
      "l was array, is now string",
    ]);
  });

  it("compares the values of an id-keyed map, not its keys", () => {
    const committed = { m: { "id-1": { n: 1 }, "id-2": { n: 2 } } };
    const fresh = { m: { "id-9": { n: 3 } } };
    expect(problems(committed, fresh)).toEqual([
      "m.id-1 was removed",
      "m.id-2 was removed",
    ]);
    expect(problems(committed, fresh, ["m.*"])).toEqual([]);
    expect(problems(committed, { m: { "id-9": { n: "x" } } }, ["m.*"])).toEqual(
      ["m.*.n was number, is now string"],
    );
    expect(problems(committed, { m: { "id-9": {} } }, ["m.*"])).toEqual([
      "m.*.n was removed",
    ]);
    // An empty map on either side says nothing.
    expect(problems(committed, { m: {} }, ["m.*"])).toEqual([]);
    expect(problems({ m: {} }, fresh, ["m.*"])).toEqual([]);
  });

  it("finds a map inside arrays and maps of lists", () => {
    const committed = { l: [{ byId: { a: [{ n: 1 }] } }] };
    expect(
      problems(committed, { l: [{ byId: { z: [{ n: 2 }] } }] }, ["l[].byId.*"]),
    ).toEqual([]);
    expect(
      problems(committed, { l: [{ byId: { z: [{ n: "2" }] } }] }, [
        "l[].byId.*",
      ]),
    ).toEqual(["l[].byId.*[].n was number, is now string"]);
  });

  it("builds messages that name the file, the path and how to update", () => {
    const messages = contractProblems(
      "src/lib/testing/fixtures/app-contract/x.json",
      '{"data":{"a":1}}',
      { data: {} },
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      "src/lib/testing/fixtures/app-contract/x.json",
    );
    expect(messages[0]).toContain("data.a was removed");
    expect(messages[0]).toContain(
      "UPDATE_APP_CONTRACT=1 bun run test src/routes/api/app/v1/contract.test.ts",
    );
    expect(contractProblems("x.json", '{"a":1}', { a: 2, b: 3 })).toEqual([]);
  });

  it("fails a missing or unreadable fixture with the same hint", () => {
    for (const text of [null, "{nope"]) {
      const messages = contractProblems(
        "src/lib/testing/fixtures/app-contract/y.json",
        text,
        {},
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        "src/lib/testing/fixtures/app-contract/y.json",
      );
      expect(messages[0]).toContain("UPDATE_APP_CONTRACT=1");
    }
  });
});

// --- captures -------------------------------------------------------------------

const DIR = fileURLToPath(
  new URL("../../../../lib/testing/fixtures/app-contract/", import.meta.url),
);
const REL_DIR = "src/lib/testing/fixtures/app-contract";
const UPDATE = process.env.UPDATE_APP_CONTRACT === "1";

/**
 * Id-keyed maps in the page data (their keys are row ids, so they differ on every
 * run), per fixture: the values of these objects are compared instead of the keys.
 * `*` stands for any fixture of that page.
 */
const MAPS: Record<string, string[]> = {
  "accounts.id.*": ["data.portfolioValues.*", "data.transactionLinks.*"],
  "accounts.id.imports": ["data.impacts.*"],
};

/**
 * Values that must never be committed, replaced before a capture is compared or
 * written. Everything here is synthetic data, redacted because it is random per run
 * or looks like (and in a real instance would be) a secret.
 */
interface Redaction {
  /** Fixture name, or `*` for every fixture. */
  file: string;
  /** JSON path like the ones in the messages (`[]` for every element). */
  path: string;
  value: string;
  why: string;
}
const REDACTIONS: Redaction[] = [
  {
    file: "import",
    path: "data.inbox.folder",
    value: "/var/lib/kept/inbox/alice",
    why: "a server path of the machine the test ran on",
  },
];

/**
 * Replaces what REDACTIONS lists. `removed` returns the original values, so the caller
 * can check that none of them survives elsewhere in the same fixture.
 */
function redact(
  file: string,
  body: unknown,
): { body: unknown; removed: string[] } {
  const removed: string[] = [];
  const copy = JSON.parse(JSON.stringify(body)) as unknown;
  for (const r of REDACTIONS) {
    if (r.file !== "*" && r.file !== file) continue;
    const segments = r.path
      .split(".")
      .flatMap((s) => (s.endsWith("[]") ? [s.slice(0, -2), "[]"] : [s]));
    const apply = (node: unknown, rest: string[]): void => {
      if (rest.length === 0 || node === null || typeof node !== "object")
        return;
      const [head, ...tail] = rest;
      if (head === "[]") {
        if (Array.isArray(node)) for (const el of node) apply(el, tail);
        return;
      }
      if (Array.isArray(node)) return;
      const record = node as Record<string, unknown>;
      if (!(head! in record)) return;
      if (tail.length === 0) {
        const was = record[head!];
        if (typeof was === "string" && was !== r.value) removed.push(was);
        if (was !== null) record[head!] = r.value;
      } else apply(record[head!], tail);
    };
    apply(copy, segments);
  }
  return { body: copy, removed };
}

/** Field names that would hold a secret; a new one in the page data fails the test until someone has looked at it. */
const SECRET_KEY =
  /^(password|passwordHash|hash|tokenHash|token|webhookToken|secret|webhookSecret|secretHash|tokenEncrypted|configEncrypted|recoveryCodes?|totpSecret|apiKey|privateKey)$/i;
/** Fields of that kind that are in the page data on purpose, per fixture (they are redacted above). */
const SECRET_KEY_EXCEPTIONS: Record<string, string[]> = {};

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
  }
  return [];
}

function mapsFor(file: string): string[] {
  return Object.entries(MAPS).flatMap(([pattern, paths]) =>
    pattern === file ||
    (pattern.endsWith(".*") && file.startsWith(pattern.slice(0, -1)))
      ? paths
      : [],
  );
}

type Handler = (event: never) => Response | Promise<Response>;
type User = Awaited<ReturnType<typeof createTestUser>>;
type Session = Awaited<ReturnType<typeof loginTestUser>>["session"];

interface Captured {
  file: string;
  body: unknown;
}

describe("contract: every bridged page, against the committed fixtures", () => {
  useTestDB();
  useTestStore();

  /** The watch folder switched on, with one scan done: an import, a file to review, a failure and a repeat. */
  async function withInbox<T>(
    username: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "kept-contract-inbox-"));
    const userDir = join(root, username);
    mkdirSync(join(userDir, "Example Wallet"), { recursive: true });
    writeFileSync(join(userDir, "unknown.csv"), fixture("csv/overlap-a.csv"));
    writeFileSync(
      join(userDir, "Example Wallet", "statement.csv"),
      fixture("csv/overlap-b.csv"),
    );
    writeFileSync(join(userDir, "again.xml"), fixture("camt053/overlap-a.xml"));
    writeFileSync(
      join(userDir, "euro.xml"),
      buildCamt({
        iban: FOREIGN_IBANS[0],
        currency: "EUR",
        entries: [
          {
            date: addDays(localToday(), -2),
            amount: "15.40",
            sign: "DBIT",
            ref: "INBOX-1",
          },
        ],
      }),
    );
    vi.stubEnv("KEPT_INBOX_DIR", root);
    try {
      // Files settle for ten seconds before they are picked up.
      setLastScan(
        await scanInbox(
          { dir: root, intervalSeconds: 60 },
          { now: Date.now() + 3_600_000 },
        ),
      );
      return await run();
    } finally {
      setLastScan(null);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function get(
    handler: Handler,
    user: User | null,
    session: Session | null,
    path: string | null,
    url: string,
  ): Promise<unknown> {
    const event = createTestEvent({
      user,
      session,
      params: path === null ? {} : { path },
      url: `http://localhost${url}`,
    });
    const res = await handler(event as never);
    const text = await res.text();
    expect(res.status, `${url}: ${text.slice(0, 200)}`).toBe(200);
    return JSON.parse(text) as unknown;
  }

  it("matches the shape of the committed captures", async () => {
    const user = await createTestUser({
      username: "alice",
      displayName: "Alice Example",
      role: "admin",
    });
    const other = await createTestUser({
      username: "bob",
      displayName: "Bob Example",
    });
    const ids: ContractIds = await seedContractData(user.id);
    await seedOtherUserData(other.id);

    const { session } = await loginTestUser(user);
    const captured: Captured[] = [];

    /** One page; `label` becomes part of the file name, `as` is who asks. */
    const page = async (
      apiPath: string,
      name: string,
      query = "",
      as: { user: User; session: Session } = { user, session },
    ) => {
      const body = (await get(
        pageGet as Handler,
        as.user,
        as.session,
        apiPath,
        `/api/app/v1/pages/${apiPath}${query === "" ? "" : `?${query}`}`,
      )) as Record<string, unknown>;
      // A redirect means the seed is missing something (or the page is not for this user).
      expect(
        Object.keys(body),
        `${apiPath}${query ? `?${query}` : ""} answered ${JSON.stringify(body).slice(0, 200)}`,
      ).toEqual(["data"]);
      captured.push({ file: name, body });
    };
    const a = ids.accounts;
    const b = ids.bills;

    await page("dashboard", "dashboard", "range=6m");
    await page("accounts", "accounts");
    await page(
      `accounts/${a.checking}`,
      "accounts.id.checking",
      `tx=${ids.focusTransactionId}`,
    );
    await page(
      `accounts/${a.checking}`,
      "accounts.id.checking.tax",
      "q=Example Tax Office",
    );
    await page(
      `accounts/${a.checking}`,
      "accounts.id.checking.donations",
      "q=Example Charity",
    );
    await page(`accounts/${a.savings}`, "accounts.id.savings");
    await page(`accounts/${a.creditCard}`, "accounts.id.credit-card");
    await page(`accounts/${a.investment}`, "accounts.id.investment");
    await page(`accounts/${a.pillar3a}`, "accounts.id.pillar3a");
    await page(`accounts/${a.pension}`, "accounts.id.pension");
    await page(`accounts/${a.euro}`, "accounts.id.euro");
    await page(`accounts/${a.joint}`, "accounts.id.joint");
    await page(`accounts/${a.checking}/imports`, "accounts.id.imports");
    await page("bills", "bills");
    await page("bills/new", "bills.new");
    await page("bills/new", "bills.new.document", `document=${ids.documentId}`);
    await page(`bills/${b.open}`, "bills.id.open");
    await page(`bills/${b.partial}`, "bills.id.partial");
    await page(`bills/${b.paid}`, "bills.id.paid");
    await page(`bills/${b.creditNote}`, "bills.id.credit-note");
    await page("budgets", "budgets", `month=${ids.budgetMonth}`);
    await page("forecast", "forecast", "days=60");
    await withInbox(user.username, () =>
      page("import", "import", `account=${a.checking}`),
    );
    await page(`import/${ids.pending.statement}`, "import.pendingId");
    await page(`import/${ids.pending.csv}`, "import.pendingId.needs-mapping");
    await page(`import/${ids.pending.csv}/mapping`, "import.pendingId.mapping");
    await page("investments", "investments", `prices=${ids.securities.etf}`);
    await page("pillar-3a", "pillar-3a");
    await page("recurring", "recurring");
    await page("reports", "reports");
    await page("review", "review", `year=${ids.budgetMonth.slice(0, 4)}`);
    await page("taxes", "taxes");
    await page(`taxes/${ids.taxYear}`, "taxes.year");
    await page("settings/account", "settings.account");
    await page("settings/categories", "settings.categories");
    await page("settings/market-data", "settings.market-data");
    await page("settings/notifications", "settings.notifications");
    await page("settings/preferences", "settings.preferences");

    captured.push({
      file: "session",
      body: await get(
        sessionGet as Handler,
        user,
        session,
        null,
        "/api/app/v1/session",
      ),
    });
    captured.push({
      file: "server",
      body: await get(
        serverGet as Handler,
        null,
        null,
        null,
        "/api/app/v1/server",
      ),
    });
    captured.push({
      file: "reminders",
      body: await get(
        remindersGet as Handler,
        user,
        session,
        null,
        "/api/app/v1/reminders?billDueDays=30&billOverdue=true&budgetPercent=50&staleImportDays=1",
      ),
    });

    const names = captured.map((c) => c.file);
    expect(new Set(names).size, "capture names are unique").toBe(names.length);
    const redacted = captured.map((c) => {
      const { body, removed } = redact(c.file, c.body);
      return { file: c.file, body, removed };
    });

    // Nothing of the other user, and no secret, may reach a fixture.
    const secrets = [
      "example-ntfy-token",
      "example-webhook-secret",
      user.password,
    ];
    for (const { file, body, removed } of redacted) {
      const text = JSON.stringify(body);
      for (const value of removed) {
        expect(text, `${file} still contains a redacted value`).not.toContain(
          value,
        );
      }
      for (const key of allKeys(body)) {
        const allowed = SECRET_KEY_EXCEPTIONS[file]?.includes(key) ?? false;
        expect(
          SECRET_KEY.test(key) && !allowed,
          `${file} has a field named "${key}": if it carries a secret, redact it in REDACTIONS and list it in SECRET_KEY_EXCEPTIONS, else list it as harmless`,
        ).toBe(false);
      }
      expect(text, `${file} shows the other user's data`).not.toContain(
        OTHER_USER_MARKER,
      );
      expect(text, `${file} shows the other user's id`).not.toContain(other.id);
      for (const secret of secrets) {
        expect(text, `${file} contains a secret`).not.toContain(secret);
      }
      expect(text, `${file} contains a bearer token`).not.toMatch(
        /kept_[A-Za-z0-9_-]{20,}/,
      );
    }

    const pretty = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      const keep = new Set(redacted.map((c) => `${c.file}.json`));
      for (const entry of readdirSync(DIR)) {
        if (entry.endsWith(".json") && !keep.has(entry)) {
          rmSync(`${DIR}${entry}`);
        }
      }
      for (const { file, body } of redacted) {
        writeFileSync(`${DIR}${file}.json`, pretty(body));
      }
      return;
    }

    const failures = redacted.flatMap(({ file, body }) => {
      const path = `${DIR}${file}.json`;
      return contractProblems(
        `${REL_DIR}/${file}.json`,
        existsSync(path) ? readFileSync(path, "utf8") : null,
        body,
        mapsFor(file),
      );
    });
    expect(failures.join("\n")).toBe("");

    // A fixture nobody captures any more is stale.
    const stale = readdirSync(DIR).filter(
      (entry) => entry.endsWith(".json") && !names.includes(entry.slice(0, -5)),
    );
    expect(
      stale.map((s) => `${REL_DIR}/${s}`).join("\n"),
      `these fixtures are no longer captured: delete them, or ${UPDATE_HINT}`,
    ).toBe("");
  }, 180_000);
});
