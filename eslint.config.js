import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

/**
 * Query builders are awaited, never executed through their sync-style terminals:
 * `.get()` skips first() (and its limit), `.run()` hides the result shape, and
 * none of them exists on every database backend. The facade's `DB` type
 * already omits them on the connection itself; this covers the builders.
 */
const queryTerminalBan = {
  selector:
    "CallExpression[arguments.length=0] > MemberExpression.callee[property.name=/^(all|get|run|execute)$/]",
  message:
    "Await the query (or use first()) instead of .all()/.get()/.run()/.execute().",
};

export default ts.config(
  {
    ignores: [
      ".svelte-kit/",
      ".claude/worktrees/",
      "build/",
      "coverage/",
      "drizzle/",
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
        svelteConfig,
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
    files: ["src/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", queryTerminalBan] },
  },
  {
    // Raw bun:sqlite statements (`copy.query(sql).get()`), not drizzle
    // builders: this test inspects a backup file with the driver directly.
    files: ["src/lib/server/backup/backup.test.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
