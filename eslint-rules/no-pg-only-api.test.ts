import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-eslint";
import { describe, expect, it } from "vitest";
import noPgOnlyApi from "./no-pg-only-api.js";

const root = join(import.meta.dirname, "..");
const fixtures = join(import.meta.dirname, "fixtures");

async function lint(file: string, options: Record<string, unknown> = {}) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: ts.parser,
          parserOptions: {
            project: [join(fixtures, "tsconfig.json")],
            tsconfigRootDir: fixtures,
          },
        },
        plugins: { kept: { rules: { "no-pg-only-api": noPgOnlyApi } } },
        rules: { "kept/no-pg-only-api": ["error", options] },
      },
    ],
  });
  const [result] = await eslint.lintFiles([join(fixtures, file)]);
  return result.messages;
}

/** Report counts by line, as `line N: text` so a failure shows the code. */
function counted(file: string, messages: { line: number; fatal?: boolean }[]) {
  const source = readFileSync(join(fixtures, file), "utf8").split("\n");
  const counts: Record<string, number> = {};
  for (const message of messages) {
    expect(message.fatal, JSON.stringify(message)).toBeFalsy();
    const key = `${message.line}: ${source[message.line - 1].trim()}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** See the header of pg-only.fixture.ts for the `// @ban N M K` markers. */
function expected(
  file: string,
  mode: "default" | "dialectCode" | "driverImports",
) {
  const counts: Record<string, number> = {};
  readFileSync(join(fixtures, file), "utf8")
    .split("\n")
    .forEach((text, index) => {
      const match = /\/\/ @ban(?: (\d+)(?: (\d+)(?: (\d+))?)?)?\s*$/.exec(text);
      if (!match) return;
      const normal = Number(match[1] ?? 1);
      const dialect = Number(match[2] ?? normal);
      const drivers = Number(match[3] ?? dialect);
      const count =
        mode === "dialectCode"
          ? dialect
          : mode === "driverImports"
            ? drivers
            : normal;
      if (count > 0) counts[`${index + 1}: ${text.trim()}`] = count;
    });
  return counts;
}

describe("kept/no-pg-only-api", () => {
  it("reports every postgres-only api in the fixture, and only those", async () => {
    const file = "pg-only.fixture.ts";
    const want = expected(file, "default");
    expect(Object.keys(want).length).toBeGreaterThan(30);
    expect(counted(file, await lint(file))).toEqual(want);
  }, 120_000);

  it("leaves portable drizzle code, zod arrays and Symbol.for alone", async () => {
    const file = "portable.fixture.ts";
    expect(counted(file, await lint(file))).toEqual({});
  }, 120_000);

  it("allows raw casts and driver imports in dialect code only", async () => {
    const file = "pg-only.fixture.ts";
    const want = expected(file, "dialectCode");
    expect(want).not.toEqual(expected(file, "default"));
    expect(counted(file, await lint(file, { dialectCode: true }))).toEqual(
      want,
    );
  }, 120_000);

  it("allows driver imports alone in tests, but not raw casts", async () => {
    const file = "pg-only.fixture.ts";
    const want = expected(file, "driverImports");
    expect(want).not.toEqual(expected(file, "default"));
    expect(want).not.toEqual(expected(file, "dialectCode"));
    expect(counted(file, await lint(file, { driverImports: true }))).toEqual(
      want,
    );
  }, 120_000);
});
