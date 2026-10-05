import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

/**
 * Temporary ban on the synchronous bun-sqlite terminals `.all()`, `.get()` and
 * `.run()` in files that have already been converted to `await`/`first()`.
 * Each of phases 2.2-2.6 (one domain per PR) appends the globs of the files it
 * converted, source and tests alike, e.g. "src/lib/server/auth/**". It keeps a
 * converted file from regressing until the driver swap (2.7) makes the
 * compiler reject these calls and this list and rule are deleted.
 */
const CONVERTED_TO_ASYNC = [
  // 2.2 auth
  "src/lib/server/auth/**",
  "src/lib/testing/auth.ts",
  "src/hooks.server.ts",
  "src/hooks.server.test.ts",
  "src/routes/login/**",
  "src/routes/logout/**",
  "src/routes/setup/**",
  "src/routes/api/auth/**",
  "src/routes/(app)/admin/**",
  "src/routes/(app)/settings/account/**",
  "src/routes/(app)/settings/security/**",
  // 2.3 ledger, transfers, pillar 3a, categories, tax
  "src/lib/server/ledger/**",
  "src/lib/server/transfers/**",
  "src/lib/server/pillar3a/**",
  "src/lib/server/investments/load.ts",
  "src/lib/server/investments/overview.ts",
  "src/lib/server/investments/overview.test.ts",
  "src/lib/testing/ledger.ts",
  "src/lib/testing/pillar3a.ts",
  "src/routes/(app)/accounts/**",
  "src/routes/(app)/institutions/**",
  "src/routes/(app)/pillar-3a/**",
  "src/routes/api/pillar-3a/**",
  "src/lib/server/categories/**",
  "src/lib/server/tax/**",
  "src/routes/(app)/budgets/**",
  "src/routes/(app)/settings/categories/**",
  "src/routes/(app)/taxes/**",
  // 2.4 imports, inbox
  "src/lib/server/imports/**",
  "src/lib/server/inbox/**",
  "src/lib/testing/imports.ts",
  "src/routes/(app)/import/**",
  "src/routes/api/imports/**",
];

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

const syncTerminalBan = CONVERTED_TO_ASYNC.length
  ? [
      {
        files: CONVERTED_TO_ASYNC,
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
    ]
  : [];

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
);
