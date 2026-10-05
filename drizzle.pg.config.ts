import { defineConfig } from "drizzle-kit";

// See drizzle.sqlite.config.ts: the dialect is pinned in the config body, before
// drizzle-kit loads the schema, and this file must not import the schema.
const url = process.env.DATABASE_URL ?? "";
process.env.KEPT_DRIZZLE_KIT_DIALECT = "pg";
process.env.DATABASE_URL = /^postgres(?:ql)?:\/\//i.test(url)
  ? url
  : "postgres://localhost:5432/kept";

export default defineConfig({
  out: "./drizzle/postgres",
  schema: "./src/lib/server/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
});
