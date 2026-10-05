// A line ending in `// @ban N M K` must get N reports from kept/no-pg-only-api,
// M with `dialectCode: true` and K with `driverImports: true`. Omitted counts
// repeat the last one given; `// @ban` is `// @ban 1 1 1`. No other line may be
// reported.
import {
  ilike, // @ban
  notIlike, // @ban
  arrayContains, // @ban
  arrayContained, // @ban
  arrayOverlaps, // @ban
  eq,
  sql,
} from "drizzle-orm";
import { exceptAll, intersectAll } from "drizzle-orm/pg-core"; // @ban 3 2 2
import { alias, pgTable } from "drizzle-orm/pg-core"; // @ban 1 0 0
import { sqliteTable } from "drizzle-orm/sqlite-core"; // @ban 1 0 0
import { drizzle } from "drizzle-orm/bun-sqlite"; // @ban 1 0 0
import {
  index,
  instant,
  table,
  text,
  uniqueIndex,
} from "../../src/lib/server/db/columns";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

declare const db: PgDatabase<PgQueryResultHKT>;

const t = table(
  "pg_only",
  {
    id: text("id").primaryKey(),
    tags: text("tags").array(), // @ban
    at: instant("at").defaultNow(), // @ban
    code: text("code").unique("pg_only_code_uq", { nulls: "not distinct" }), // @ban
    other: text("other"),
  },
  (x) => [
    index("a_idx").using("btree", x.id), // @ban
    index("b_idx").on(x.id).concurrently(), // @ban
    index("c_idx").on(x.id).with({ fillfactor: 70 }), // @ban
    index("d_idx").on(x.id.desc()), // @ban
    index("e_idx").on(x.id.asc()), // @ban
    index("f_idx").on(x.id.nullsFirst()), // @ban
    index("g_idx").on(x.id.nullsLast()), // @ban
    uniqueIndex("h_idx").on(x.id.op("text_ops")), // @ban
  ],
);

export async function violations() {
  await db.execute(sql`select 1`); // @ban
  db.selectDistinctOn([t.id]); // @ban
  db.select().from(t).for("update"); // @ban
  db.select()
    .from(t)
    .leftJoinLateral(db.select().from(t).as("l"), sql`true`); // @ban
  db.select()
    .from(t)
    .innerJoinLateral(db.select().from(t).as("m"), sql`true`); // @ban
  db.select().from(t).crossJoinLateral(db.select().from(t).as("n")); // @ban
  db.select().from(t).where(ilike(t.id, "x"));
  db.refreshMaterializedView(null as never); // @ban
  sql`${t.id} ilike 'a%'`; // @ban 1 0 1
  sql`select distinct on (${t.id}) ${t.id} from ${t}`; // @ban 1 0 1
  sql`select 1 from ${t} for update`; // @ban 1 0 1
  sql`${t.id}::text`; // @ban 1 0 1
  return [eq, alias, pgTable, sqliteTable, drizzle, exceptAll, intersectAll];
}
