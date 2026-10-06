/**
 * Runs inside the old release's image: seeds the database that image created.
 * Usage: bun apply-seed.ts <database file> <version>
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [dbPath, version] = Bun.argv.slice(2);
if (!dbPath || !version)
  throw new Error("usage: apply-seed.ts <database> <version>");

const dir = join("/fixtures", version);
const { files } = (await import(join(dir, "fixture.ts"))) as {
  files: { path: string; content: string }[];
};
const seed = await Bun.file(join(dir, "seed.sql")).text();

const db = new Database(dbPath, { strict: true });
db.exec("PRAGMA foreign_keys = ON;");
db.exec(seed);
const violations = db.query("PRAGMA foreign_key_check").all();
if (violations.length > 0) {
  throw new Error(`the seed breaks ${violations.length} foreign keys`);
}
db.close();

for (const file of files) {
  const target = join(dirname(dbPath), file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content);
}
console.error(`seeded ${dbPath} and wrote ${files.length} files`);
