import { defineConfig } from "drizzle-kit";

// drizzle-kit loads this file first and the schema afterwards, in one process.
// Pin the dialect here, in the body: the schema resolves its dialect from the
// environment when it is loaded, and throws if it disagrees with the pin. Do
// not import the schema (or anything that resolves the dialect) from here.
process.env.KEPT_DRIZZLE_KIT_DIALECT = "sqlite";
delete process.env.DATABASE_URL;

export default defineConfig({
  out: "./drizzle/sqlite",
  schema: "./src/lib/server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/kept.db",
  },
});
