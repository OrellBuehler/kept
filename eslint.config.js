import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

/**
 * Temporary ban on the synchronous bun-sqlite terminals `.all()`, `.get()` and
 * `.run()` everywhere in `src/`: every query is awaited (or goes through
 * `first()`), so the driver swap (2.7) only has to touch the transaction
 * bodies. It keeps converted code from regressing until 2.7 makes the compiler
 * reject these calls and this rule is deleted.
 */
const SYNC_TERMINAL_BAN_FILES = ["src/**"];

/**
 * The sync terminals stay legal inside the synchronous transaction bodies and
 * the helpers that only run there (until 2.7 makes those async too). Both take
 * the transaction as their first parameter, named `tx`, so the ban skips any
 * call lexically inside a function declared that way.
 */
const OUTSIDE_TX_BODY =
  ":not(:matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)[params.0.name='tx'] *)";

/**
 * bun-sqlite transactions are synchronous: an async callback commits (or rolls
 * back) at its first await, and the rest of the body runs outside the
 * transaction. Applies to every TypeScript file until phase 2.7 swaps the driver.
 * A later `no-restricted-syntax` block replaces this one wholesale, so any block
 * that sets the rule for a subset of files must repeat this entry.
 */
const asyncTransactionBan = {
  selector:
    "CallExpression[callee.property.name='transaction'] > :matches(ArrowFunctionExpression, FunctionExpression)[async=true]",
  message:
    "bun-sqlite transactions must be synchronous until phase 2.7: do not pass an async callback to .transaction().",
};

const syncTerminalBan = [
  {
    files: SYNC_TERMINAL_BAN_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        asyncTransactionBan,
        {
          selector:
            "CallExpression[arguments.length=0] > MemberExpression.callee[property.name=/^(all|get|run)$/]" +
            OUTSIDE_TX_BODY,
          message:
            "Await the query (or use first()) instead of .all()/.get()/.run().",
        },
      ],
    },
  },
];

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
    rules: { "no-restricted-syntax": ["error", asyncTransactionBan] },
  },
  ...syncTerminalBan,
  {
    // Raw bun:sqlite statements (`db.query(sql).get()`), not drizzle builders:
    // this test inspects a backup file with the driver directly.
    files: ["src/lib/server/backup/backup.test.ts"],
    rules: { "no-restricted-syntax": ["error", asyncTransactionBan] },
  },
);
