import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import {
  compareUpgrade,
  diffSnapshots,
  encodeCell,
  int,
  takeSnapshot,
  text,
  type Expected,
} from "./lib";

const none: Expected = {
  newTables: [],
  newColumns: {},
  newColumnValues: () => ({}),
  changes: {},
};

function database(setup: string): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);",
  );
  db.exec(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h1', 1);",
  );
  db.exec(setup);
  return db;
}

const base = `
  CREATE TABLE parent (id text PRIMARY KEY NOT NULL, name text, amount);
  CREATE TABLE child (id text PRIMARY KEY NOT NULL, parent_id text REFERENCES parent(id) ON DELETE cascade);
  CREATE UNIQUE INDEX parent_name_uq ON parent (name);
  INSERT INTO parent VALUES ('p1', 'one', 100), ('p2', 'two', NULL);
  INSERT INTO child VALUES ('c1', 'p1');
`;

describe("encodeCell", () => {
  it("tags the storage class so 5, '5', 5.5 and blobs differ", () => {
    expect(encodeCell(5)).toBe("i:5");
    expect(encodeCell("5")).toBe("t:5");
    expect(encodeCell(5.5)).toBe("r:5.5");
    expect(encodeCell(new Uint8Array([0, 255]))).toBe("b:00ff");
    expect(encodeCell(null)).toBeNull();
    expect(encodeCell(9007199254740993n)).toBe("i:9007199254740993");
  });
});

describe("compareUpgrade", () => {
  const before = takeSnapshot(database(base));

  it("accepts an unchanged database", () => {
    expect(compareUpgrade(before, takeSnapshot(database(base)), none)).toEqual(
      [],
    );
  });

  it("reports a lost row, a changed value and a changed storage class", () => {
    const lost = takeSnapshot(database(base + "DELETE FROM child;"));
    expect(compareUpgrade(before, lost, none)).toEqual([
      "child[t:c1]: row lost",
    ]);

    const changed = takeSnapshot(
      database(base + "UPDATE parent SET name = 'uno' WHERE id = 'p1';"),
    );
    expect(compareUpgrade(before, changed, none)).toEqual([
      "parent[t:p1].name: t:one became t:uno, expected t:one",
    ]);

    const retyped = takeSnapshot(
      database(base + "UPDATE parent SET amount = '100' WHERE id = 'p1';"),
    );
    expect(compareUpgrade(before, retyped, none)).toHaveLength(1);
  });

  it("accepts a change that is expected and nothing beyond it", () => {
    const after = takeSnapshot(
      database(base + "UPDATE parent SET amount = NULL WHERE id = 'p1';"),
    );
    const expected: Expected = {
      ...none,
      changes: { parent: { "t:p1": { amount: null } } },
    };
    expect(compareUpgrade(before, after, expected)).toEqual([]);
    expect(compareUpgrade(before, after, none)).toHaveLength(1);
  });

  it("checks added columns and tables against the expectation", () => {
    const after = takeSnapshot(
      database(
        base +
          "ALTER TABLE parent ADD COLUMN seq integer DEFAULT 0 NOT NULL; UPDATE parent SET seq = rowid; CREATE TABLE extra (id text PRIMARY KEY);",
      ),
    );
    expect(compareUpgrade(before, after, none).join("\n")).toContain(
      "added columns [seq]",
    );
    const expected: Expected = {
      newTables: ["extra"],
      newColumns: { parent: ["seq"] },
      newColumnValues: (_table, row) => ({ seq: row.__rowid }),
      changes: {},
    };
    expect(compareUpgrade(before, after, expected)).toEqual([]);
    const wrong = { ...expected, newColumnValues: () => ({ seq: int(7) }) };
    expect(compareUpgrade(before, after, wrong)).toHaveLength(2);
  });

  it("reports a dropped table, index and foreign key", () => {
    const rebuilt = takeSnapshot(
      database(`
        CREATE TABLE parent (id text PRIMARY KEY NOT NULL, name text, amount);
        CREATE TABLE child (id text PRIMARY KEY NOT NULL, parent_id text);
        INSERT INTO parent VALUES ('p1', 'one', 100), ('p2', 'two', NULL);
        INSERT INTO child VALUES ('c1', 'p1');
      `),
    );
    const problems = compareUpgrade(before, rebuilt, none);
    expect(problems).toContain("index parent_name_uq disappeared");
    expect(problems.some((p) => p.includes("foreign key"))).toBe(true);
  });

  it("reports a weakened column definition and a redefined index", () => {
    const weaker = takeSnapshot(
      database(`
        CREATE TABLE parent (id text PRIMARY KEY NOT NULL, name text DEFAULT 'x', amount);
        CREATE TABLE child (id text PRIMARY KEY, parent_id text REFERENCES parent(id) ON DELETE cascade);
        CREATE INDEX parent_name_uq ON parent (name);
        INSERT INTO parent VALUES ('p1', 'one', 100), ('p2', 'two', NULL);
        INSERT INTO child VALUES ('c1', 'p1');
      `),
    );
    const problems = compareUpgrade(before, weaker, none).join("\n");
    expect(problems).toContain("parent.name: definition changed");
    expect(problems).toContain("child.id: definition changed");
    expect(problems).toContain("index parent_name_uq was redefined");
  });

  it("reports violations the database itself finds", () => {
    const db = database(base);
    db.exec(
      "PRAGMA foreign_keys = OFF; INSERT INTO child VALUES ('c2', 'missing');",
    );
    const problems = compareUpgrade(before, takeSnapshot(db), none);
    expect(problems.some((p) => p.startsWith("foreign_key_check"))).toBe(true);
  });

  it("reports a changed migration history", () => {
    const db = database(base);
    db.exec("UPDATE __drizzle_migrations SET hash = 'other';");
    expect(compareUpgrade(before, takeSnapshot(db), none)).toContain(
      "migration history entry 0 changed",
    );
  });
});

describe("diffSnapshots", () => {
  it("names the rows and columns that differ, and skips ignored tables", () => {
    const a = takeSnapshot(database(base));
    const b = takeSnapshot(
      database(
        base +
          "UPDATE parent SET name = 'uno' WHERE id = 'p1'; INSERT INTO child VALUES ('c2', 'p2');",
      ),
    );
    expect(diffSnapshots(a, b)).toEqual([
      "table child[t:c2]: row added",
      "table parent[t:p1].name: t:one became t:uno",
    ]);
    expect(diffSnapshots(a, b, ["child", "parent"])).toEqual([]);
    expect(text("x")).toBe("t:x");
  });
});
