import { join } from "node:path";
import {
  createTemplate,
  sealTemplate,
  sweepDatabases,
  TEMPLATE_DB,
  urlFor,
} from "./pg";

/**
 * Once per `pg` run: a `kept_template` database with the C collation (so
 * ORDER BY matches SQLite's binary order) and every migration applied. Test
 * files copy it instead of migrating again; the returned teardown removes
 * everything the run created.
 */
export default async function setup(): Promise<() => Promise<void>> {
  await sweepDatabases();
  await createTemplate();

  // The schema picks its dialect from DATABASE_URL when it is first loaded.
  process.env.DATABASE_URL = urlFor(TEMPLATE_DB);
  const { readDatabaseConfig } = await import("$lib/server/db/config");
  const { openPostgres, migratePostgres } =
    await import("$lib/server/db/postgres");
  const config = readDatabaseConfig();
  if (config.kind !== "postgres") throw new Error("expected a postgres config");
  const backend = openPostgres({ ...config, poolMax: 2 });
  try {
    await migratePostgres(backend, join(process.cwd(), "drizzle", "postgres"));
  } finally {
    await backend.close();
  }
  await sealTemplate();

  return async () => {
    await sweepDatabases();
  };
}
