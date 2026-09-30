import { runMigrations } from "$lib/server/db";

export function init() {
  runMigrations();
}
