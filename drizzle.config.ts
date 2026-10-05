// drizzle-kit needs the dialect pinned before the schema loads; a run without one of the
// pinned configs could build the schema for the wrong dialect and generate DROP migrations.
throw new Error(
  "Use `bun run db:generate` (drizzle.sqlite.config.ts) or --config drizzle.pg.config.ts.",
);
