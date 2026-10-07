/**
 * Runs inside the image under test, with the server stopped: `api_tokens` did not exist in the
 * release the database came from, so the token the HTTP checks use is inserted here.
 * Usage: bun add-api-token.ts <database file> <version>
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const [dbPath, version] = Bun.argv.slice(2);
if (!dbPath || !version)
  throw new Error("usage: add-api-token.ts <database> <version>");
const { apiToken } = (await import(
  join("/fixtures", version, "fixture.ts")
)) as {
  apiToken: string;
};

const hash = new Bun.CryptoHasher("sha256").update(apiToken).digest("hex");
const db = new Database(dbPath, { strict: true });
db.exec("PRAGMA foreign_keys = ON;");
db.query(
  "INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes) VALUES (?, ?, ?, ?, ?, ?)",
).run(
  "tok-upgrade-fixture",
  "usr-alice",
  "upgrade fixture",
  hash,
  apiToken.slice(0, 11),
  JSON.stringify([
    "bills:read",
    "transactions:read",
    "recurring:read",
    "categories:read",
    "accounts:read",
  ]),
);
db.close();
