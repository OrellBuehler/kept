/**
 * Prints a snapshot (see lib.ts) of a SQLite database as JSON.
 * Usage: bun snapshot.ts <database file>
 */
import { Database } from "bun:sqlite";
import { takeSnapshot } from "./lib";

const [dbPath] = Bun.argv.slice(2);
if (!dbPath) throw new Error("usage: snapshot.ts <database>");
const db = new Database(dbPath, { readonly: true, strict: true });
console.log(JSON.stringify(takeSnapshot(db)));
db.close();
