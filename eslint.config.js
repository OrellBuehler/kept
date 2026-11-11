import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";

import noPgOnlyApi from "./eslint-rules/no-pg-only-api.js";
import noQueryTerminals from "./eslint-rules/no-query-terminals.js";

const kept = {
  rules: {
    "no-query-terminals": noQueryTerminals,
    "no-pg-only-api": noPgOnlyApi,
  },
};

export default ts.config(
  {
    ignores: [
      ".svelte-kit/",
      ".claude/worktrees/",
      "build/",
      "coverage/",
      "drizzle/",
      "eslint-rules/fixtures/",
      "src/lib/components/ui/",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, Bun: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
      },
    },
  },
  {
    // A forgotten await on a drizzle query builder silently drops the query,
    // so these rules are errors. They need type information, so they run on
    // TypeScript files only. `bun run lint` also lints the .ts files in a
    // separate eslint process from everything else: mixed in one process,
    // typescript-eslint rebuilds the checker whenever it alternates between
    // .ts and .svelte files, which turns a ~75s run into ~9 minutes.
    files: ["src/**/*.ts"],
    rules: {
      // drizzle's query builders implement PromiseLike without extending
      // Promise, so they are only recognised with checkThenables.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { checkThenables: true },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Builders are awaited, never run through their sync-style terminals; see
    // the rule for how a builder is recognised (by type, so Map.get is fine).
    files: ["src/**/*.ts"],
    plugins: { kept },
    rules: { "kept/no-query-terminals": "error" },
  },
  {
    // The schema and the queries are typed as pg-core but run on SQLite too, so
    // the postgres-only api surface is banned (see the rule for the list).
    files: ["src/**/*.ts"],
    plugins: { kept },
    rules: { "kept/no-pg-only-api": "error" },
  },
  {
    // db/ is dialect code by nature: it may cast in raw SQL and import the
    // drivers and the dialect-specific core packages.
    files: ["src/lib/server/db/**/*.ts"],
    rules: { "kept/no-pg-only-api": ["error", { dialectCode: true }] },
  },
  {
    // Tests may run the migrator and open raw handles; their SQL must still be
    // portable, because the suite also runs against PostgreSQL.
    files: ["src/**/*.test.ts"],
    ignores: ["src/lib/server/db/**"],
    rules: { "kept/no-pg-only-api": ["error", { driverImports: true }] },
  },
);
