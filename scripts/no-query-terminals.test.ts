import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Type-aware linting builds the TypeScript program once; the text is linted
// as if it were this existing file, so the project service finds it.
const FILE = resolve("src/lib/server/db/index.test.ts");
const eslint = new ESLint({ cwd: resolve(".") });

async function flagged(body: string): Promise<string[]> {
  const code = `import { getDB, users } from "$lib/server/db";
export async function probe() {
  const db = getDB();
  const map = new Map<string, number>();
  const params = new URLSearchParams();
  const form = new FormData();
${body}
  return [db, map, params, form];
}
`;
  const [result] = await eslint.lintText(code, { filePath: FILE });
  return result!.messages
    .filter((m) => m.ruleId === "kept/no-query-terminals")
    .map((m) => code.split("\n")[m.line - 1]!.trim());
}

describe("kept/no-query-terminals", () => {
  it("leaves Map, Set, URLSearchParams and FormData alone", async () => {
    expect(
      await flagged(`
  map.get("a");
  [...map.values()];
  new Set<number>().values();
  params.get("a");
  form.get("a");
  new Headers().get("a");`),
    ).toEqual([]);
  });

  it("leaves an insert's own .values(row) alone", async () => {
    expect(
      await flagged(`
  await db.insert(users).values({ username: "a", passwordHash: "b" });`),
    ).toEqual([]);
  });

  it.each(["all", "get", "values", "run", "execute"])(
    "flags .%s() on a select builder, with or without arguments",
    async (terminal) => {
      expect(
        await flagged(`
  void db.select().from(users).${terminal}();
  void db.select().from(users).where(undefined).${terminal}(1);`),
      ).toHaveLength(2);
    },
  );

  it("flags terminals on insert, update and delete builders", async () => {
    expect(
      await flagged(`
  void db.insert(users).values({ username: "a", passwordHash: "b" }).run();
  void db.update(users).set({ username: "b" }).run();
  void db.delete(users).execute();
  void db.insert(users).values({ username: "a", passwordHash: "b" }).returning().all();`),
    ).toHaveLength(4);
  });
});
