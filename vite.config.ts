import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { pwaOptions } from "./src/lib/pwa-config.ts";

const pgUrl = process.env.KEPT_TEST_DATABASE_URL?.trim() ?? "";
// Only selects the dialect: it names no real database, so a test that reaches
// for the database without provisioning one fails instead of using the server's.
const pgDialectUrl = pgUrl
  ? (() => {
      const u = new URL(pgUrl);
      u.pathname = "/kept_unprovisioned";
      return u.toString();
    })()
  : "";

// Fake servers in tests listen on loopback; tests of the default policy unset this.
const commonEnv = { KEPT_ALLOW_PRIVATE_NETWORK: "true" };

// Left out of the `pg` project. Each opens SQLite files itself or exercises
// the SQLite-only single-connection design; the PostgreSQL equivalents live in
// src/lib/server/db/postgres.pg.test.ts.
const pgExclude: string[] = [
  // VACUUM INTO copies, restore and the scheduled-backup loop (phase 3.5 gates backups on PostgreSQL).
  "src/lib/server/backup/**",
  // The SQLite gate: FIFO queueing on one connection, its timeout, withExclusiveClient, the statement cache.
  "src/lib/server/db/transaction.test.ts",
  // Rollback, watchdog and savepoint behaviour built on the SQLite gate and `openDatabase(":memory:")`.
  "src/lib/server/db/hardening.test.ts",
  // A SQLite data migration, run on a hand-opened in-memory database.
  "src/lib/server/seq-migration.test.ts",
];

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), SvelteKitPWA(pwaOptions)],
  // Native/WASM-backed PDF stack must be loaded from node_modules at runtime,
  // not bundled (the zxing WASM binary is resolved relative to the package).
  ssr: {
    external: ["pdfjs-dist", "zxing-wasm", "@napi-rs/canvas", "pdfmake"],
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist", "zxing-wasm", "@napi-rs/canvas", "pdfmake"],
  },
  build: {
    rollupOptions: {
      external: [/^bun:/],
    },
  },
  test: {
    environment: "node",
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/routes/**/*.ts"],
      exclude: ["src/lib/components/ui/**"],
      reporter: ["text", "json-summary"],
    },
    // Two projects run the same suite against the two dialects. The schema
    // picks its dialect from DATABASE_URL when first loaded, which is why each
    // project sets it in `env`. `bun run test` runs `sqlite`; `bun run test:pg`
    // runs `pg`, which needs KEPT_TEST_DATABASE_URL (an admin connection to a
    // throwaway server) and skips every file without it.
    projects: [
      {
        extends: true,
        test: {
          name: "sqlite",
          include: [
            "src/**/*.test.ts",
            "scripts/**/*.test.ts",
            "eslint-rules/**/*.test.ts",
          ],
          // PostgreSQL integration tests need a server and a PostgreSQL-dialect process.
          exclude: [...configDefaults.exclude, "**/*.pg.test.ts"],
          env: {
            ...commonEnv,
            // A DATABASE_URL in the developer's shell must not flip the dialect.
            DATABASE_URL: "",
          },
        },
      },
      {
        extends: true,
        test: {
          name: "pg",
          // Without a server there is nothing to run: an empty include makes
          // the project skip instead of fail.
          include: pgUrl ? ["src/**/*.test.ts"] : [],
          exclude: [...configDefaults.exclude, ...pgExclude],
          globalSetup: ["./src/lib/testing/pg-global-setup.ts"],
          setupFiles: ["./src/lib/testing/pg-setup.ts"],
          env: {
            ...commonEnv,
            // Every test file then gets its own database (src/lib/testing/pg.ts)
            // and points DATABASE_URL at it.
            DATABASE_URL: pgDialectUrl,
            KEPT_STORAGE_DIR: join(
              tmpdir(),
              `kept-test-storage-${process.pid}`,
            ),
          },
        },
      },
    ],
  },
});
