import { afterAll } from "vitest";
import { finishFile } from "./pg";

// Runs after the last test of every file in the `pg` project: closes the pool
// and drops the file's database (nothing happens for files that never used one).
afterAll(finishFile, 60_000);
