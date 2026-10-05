import { defineConfig } from "vitest/config";
import base from "./vite.config.ts";

// The PostgreSQL integration tests (`*.pg.test.ts`). The schema picks its
// dialect from DATABASE_URL when it is first loaded, so these run in their own
// process with it set. Without KEPT_TEST_DATABASE_URL the suites skip.
const url = process.env.KEPT_TEST_DATABASE_URL ?? "";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.pg.test.ts"],
    exclude: undefined,
    env: { ...base.test?.env, DATABASE_URL: url },
  },
});
