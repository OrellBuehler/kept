/**
 * Snapshot and comparison of a SQLite database before and after an upgrade. Pure functions on
 * `bun:sqlite`, no imports from the app, so the Docker upgrade test can run them inside an image
 * that only holds the built server, and the Vitest upgrade test can import the same code.
 */
import type { Database } from "bun:sqlite";

/**
 * A stored value with its storage class, so `5`, `'5'` and `5.0` differ and a blob compares
 * byte for byte: `i:5`, `r:1.5`, `t:text`, `b:<hex>`. `null` is SQL NULL.
 */
export type Cell = string | null;

export const int = (n: number | bigint): Cell => `i:${n}`;
export const text = (s: string): Cell => `t:${s}`;

export function encodeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return `i:${value}`;
  if (typeof value === "number") {
    return Number.isInteger(value) ? `i:${value}` : `r:${value}`;
  }
  if (typeof value === "string") return `t:${value}`;
  if (value instanceof Uint8Array)
    return `b:${Buffer.from(value).toString("hex")}`;
  throw new Error(`unexpected SQLite value of type ${typeof value}`);
}

export type Row = Record<string, Cell>;

export interface TableSnapshot {
  columns: string[];
  /** Declared type, NOT NULL, default and primary key position of each column. */
  columnDefs: Record<string, string>;
  primaryKey: string[];
  /** Every row, with the SQLite rowid as `__rowid`; sorted by primary key. */
  rows: Row[];
  /** `from` columns of each foreign key, with the table they reference and the delete action. */
  foreignKeys: string[];
}

export interface Snapshot {
  tables: Record<string, TableSnapshot>;
  indexes: string[];
  /** The `CREATE INDEX` statement of each index, whitespace collapsed. */
  indexSql: Record<string, string>;
  /** The rows of `__drizzle_migrations`, in order. */
  migrations: { hash: string; createdAt: number }[];
  integrityCheck: string[];
  foreignKeyViolations: string[];
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function takeSnapshot(db: Database): Snapshot {
  const tableNames = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  const tables: Record<string, TableSnapshot> = {};
  for (const name of tableNames) {
    const info = db.query(`PRAGMA table_xinfo(${quote(name)})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }[];
    const columnDefs = Object.fromEntries(
      info.map((c) => [
        c.name,
        `${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk} hidden=${c.hidden}`,
      ]),
    );
    const columns = info.map((c) => c.name);
    const primaryKey = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const raw = db
      .query(`SELECT rowid AS __rowid, * FROM ${quote(name)} ORDER BY rowid`)
      .values() as unknown[][];
    const rows = raw.map((values) => {
      const row: Row = { __rowid: encodeCell(values[0]) };
      columns.forEach((column, i) => {
        row[column] = encodeCell(values[i + 1]);
      });
      return row;
    });
    const foreignKeys = (
      db.query(`PRAGMA foreign_key_list(${quote(name)})`).all() as {
        from: string;
        table: string;
        on_delete: string;
      }[]
    )
      .map((f) => `${f.from} -> ${f.table} on delete ${f.on_delete}`)
      .sort();
    tables[name] = { columns, columnDefs, primaryKey, rows, foreignKeys };
  }

  const indexRows = db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string; sql: string | null }[];
  const indexes = indexRows.map((r) => r.name);
  const indexSql = Object.fromEntries(
    indexRows.map((r) => [r.name, (r.sql ?? "").replace(/\s+/g, " ").trim()]),
  );

  const migrations = (
    db
      .query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id")
      .all() as { hash: string; created_at: number }[]
  ).map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));

  const integrityCheck = (
    db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]
  ).map((r) => r.integrity_check);
  const foreignKeyViolations = (
    db.query("PRAGMA foreign_key_check").all() as {
      table: string;
      rowid: number;
      parent: string;
    }[]
  ).map((r) => `${r.table} row ${r.rowid} -> ${r.parent}`);

  return {
    tables,
    indexes,
    indexSql,
    migrations,
    integrityCheck,
    foreignKeyViolations,
  };
}

/** The key that identifies a row across both snapshots: its primary key values. */
export function rowKey(table: TableSnapshot, row: Row): string {
  const columns = table.primaryKey.length > 0 ? table.primaryKey : ["__rowid"];
  return columns.map((c) => row[c]).join("|");
}

export interface Expected {
  /** Tables the upgrade creates. Exactly these appear, and no table disappears. */
  newTables: string[];
  /** Rows the upgrade writes into a new table (`table -> count`); the others stay empty. */
  newTableRows?: Record<string, number>;
  /** Columns the upgrade adds to an old table, exactly (`table -> columns`). */
  newColumns: Record<string, string[]>;
  /** The value of every added column in an old row; called per row of a table in `newColumns`. */
  newColumnValues: (table: string, before: Row) => Row;
  /**
   * Old columns the upgrade rewrites on purpose: `table -> primary key -> column -> new value`.
   * Every other old column of every old row must be byte for byte what it was.
   */
  changes: Record<string, Record<string, Row>>;
}

/** Everything that differs between the two snapshots and is not in `expected`; empty means a clean upgrade. */
export function compareUpgrade(
  before: Snapshot,
  after: Snapshot,
  expected: Expected,
): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(message);

  const beforeNames = Object.keys(before.tables);
  const afterNames = Object.keys(after.tables);
  for (const name of beforeNames) {
    if (!after.tables[name]) add(`table ${name} disappeared`);
  }
  const created = afterNames.filter((n) => !before.tables[n]).sort();
  const wanted = [...expected.newTables].sort();
  if (created.join() !== wanted.join()) {
    add(`new tables are [${created}], expected [${wanted}]`);
  }
  for (const name of created) {
    const count = after.tables[name].rows.length;
    const want = expected.newTableRows?.[name] ?? 0;
    if (count !== want)
      add(`new table ${name} holds ${count} rows, expected ${want}`);
  }

  for (const name of beforeNames) {
    const b = before.tables[name];
    const a = after.tables[name];
    if (!a) continue;

    const added = a.columns.filter((c) => !b.columns.includes(c)).sort();
    const wantAdded = [...(expected.newColumns[name] ?? [])].sort();
    if (added.join() !== wantAdded.join()) {
      add(`${name}: added columns [${added}], expected [${wantAdded}]`);
    }
    for (const c of b.columns) {
      if (!a.columns.includes(c)) {
        add(`${name}: column ${c} disappeared`);
      } else if (b.columnDefs[c] !== a.columnDefs[c]) {
        add(
          `${name}.${c}: definition changed from "${b.columnDefs[c]}" to "${a.columnDefs[c]}"`,
        );
      }
    }
    for (const fk of b.foreignKeys) {
      if (!a.foreignKeys.includes(fk))
        add(`${name}: foreign key ${fk} disappeared`);
    }
    if (b.primaryKey.join() !== a.primaryKey.join()) {
      add(`${name}: primary key changed`);
    }

    const afterRows = new Map(a.rows.map((r) => [rowKey(a, r), r]));
    if (afterRows.size !== a.rows.length)
      add(`${name}: duplicate keys after the upgrade`);
    const changes = expected.changes[name] ?? {};
    const seen = new Set<string>();
    for (const row of b.rows) {
      const key = rowKey(b, row);
      seen.add(key);
      const next = afterRows.get(key);
      if (!next) {
        add(`${name}[${key}]: row lost`);
        continue;
      }
      const rewrite = changes[key] ?? {};
      const fresh =
        wantAdded.length > 0 ? expected.newColumnValues(name, row) : {};
      for (const column of ["__rowid", ...b.columns]) {
        const want = column in rewrite ? rewrite[column] : row[column];
        if (next[column] !== want) {
          add(
            `${name}[${key}].${column}: ${row[column]} became ${next[column]}, expected ${want}`,
          );
        }
      }
      for (const column of wantAdded) {
        if (!(column in fresh)) {
          add(`${name}.${column}: no expected value defined`);
        } else if (next[column] !== fresh[column]) {
          add(
            `${name}[${key}].${column}: is ${next[column]}, expected ${fresh[column]}`,
          );
        }
      }
    }
    for (const key of afterRows.keys()) {
      if (!seen.has(key)) add(`${name}[${key}]: row appeared`);
    }
    for (const key of Object.keys(changes)) {
      if (!seen.has(key))
        add(`${name}[${key}]: expected change refers to an unknown row`);
    }
  }

  for (const index of before.indexes) {
    if (!after.indexes.includes(index)) {
      add(`index ${index} disappeared`);
    } else if (before.indexSql[index] !== after.indexSql[index]) {
      add(`index ${index} was redefined`);
    }
  }

  if (after.migrations.length < before.migrations.length) {
    add("migration history got shorter");
  }
  before.migrations.forEach((m, i) => {
    const n = after.migrations[i];
    if (!n || n.hash !== m.hash || n.createdAt !== m.createdAt) {
      add(`migration history entry ${i} changed`);
    }
  });

  if (after.integrityCheck.join() !== "ok") {
    add(`integrity_check: ${after.integrityCheck.join("; ")}`);
  }
  if (after.foreignKeyViolations.length > 0) {
    add(`foreign_key_check: ${after.foreignKeyViolations.join("; ")}`);
  }
  return problems;
}

/**
 * Rows that differ between two snapshots of the same schema, per table. For tables the running
 * app is allowed to write to (sessions, security log), pass them in `ignore`.
 */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  ignore: string[] = [],
): string[] {
  const problems: string[] = [];
  const names = new Set([
    ...Object.keys(before.tables),
    ...Object.keys(after.tables),
  ]);
  for (const name of [...names].sort()) {
    if (ignore.includes(name)) continue;
    const b = before.tables[name];
    const a = after.tables[name];
    if (!b || !a) {
      problems.push(`table ${name} exists in only one snapshot`);
      continue;
    }
    if (JSON.stringify(b.rows) === JSON.stringify(a.rows)) continue;
    const found = problems.length;
    const afterRows = new Map(a.rows.map((r) => [rowKey(a, r), r]));
    const beforeKeys = new Set<string>();
    for (const row of b.rows) {
      const key = rowKey(b, row);
      beforeKeys.add(key);
      const next = afterRows.get(key);
      if (!next) {
        problems.push(`table ${name}[${key}]: row removed`);
        continue;
      }
      for (const column of Object.keys(row)) {
        if (row[column] !== next[column]) {
          problems.push(
            `table ${name}[${key}].${column}: ${row[column]} became ${next[column]}`,
          );
        }
      }
    }
    for (const key of afterRows.keys()) {
      if (!beforeKeys.has(key))
        problems.push(`table ${name}[${key}]: row added`);
    }
    if (problems.length === found)
      problems.push(`table ${name}: rows reordered`);
  }
  if (JSON.stringify(before.migrations) !== JSON.stringify(after.migrations)) {
    problems.push("migration history changed");
  }
  return problems;
}
