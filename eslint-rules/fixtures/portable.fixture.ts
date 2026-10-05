// Nothing in this file may be reported by kept/no-pg-only-api.
import { and, eq, like, sql } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgDatabase,
  PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import { type PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  index,
  instant,
  table,
  text,
  uniqueIndex,
} from "../../src/lib/server/db/columns";

declare const db: PgDatabase<PgQueryResultHKT>;

const t = table(
  "portable",
  {
    id: text("id").primaryKey(),
    code: text("code").unique("portable_code_uq"),
    at: instant("at").notNull(),
    parent: text("parent").references((): AnyPgColumn => t.id),
  },
  (x) => [
    index("a_idx").on(x.id),
    index("b_idx")
      .on(x.id)
      .where(sql`${x.id} is not null`),
    uniqueIndex("c_idx").on(x.id, x.at),
  ],
);

export async function portable(table: PgTable) {
  const cte = db.$with("c").as(db.select().from(t));
  await db.with(cte).select().from(cte);
  await db
    .selectDistinct()
    .from(t)
    .where(and(eq(t.id, "a"), like(t.id, "a%")));
  await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(t)
    .where(sql`lower(${t.id}) like lower(${"a%"}) escape '\\'`);
  await db.select({ id: sql`cast(${t.id} as text)` }).from(t);
  const tag = Symbol.for("x");
  const list = z.string().array();
  const many = z.array(z.string());
  const map = new Map<string, number>();
  map.set("a", 1);
  return [table, tag, list, many, map.get("a"), "a::b", `x ${1} ilike`];
}
