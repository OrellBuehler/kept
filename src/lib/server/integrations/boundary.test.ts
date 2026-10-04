import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|svelte|js)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");

/** Files that belong to an integration or may wire it in. */
function mayImportIntegrations(path: string): boolean {
  return (
    path.startsWith("lib/server/integrations/") ||
    path.startsWith("routes/api/public/paperless/") ||
    path.startsWith("routes/(app)/settings/paperless/") ||
    path.startsWith("routes/(app)/settings/market-data/") ||
    path === "hooks.server.ts"
  );
}

describe("integration boundary", () => {
  const files = walk(SRC).map((f) => ({
    path: rel(f),
    text: readFileSync(f, "utf8"),
  }));

  it("only integrations, their routes and the startup hook import from integrations/", () => {
    const offenders = files
      .filter((f) => !mayImportIntegrations(f.path))
      .filter((f) =>
        /(?:from\s+|import\s*\(\s*)["'][^"']*\/integrations\//.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the startup hook only imports the registration entry point", () => {
    const hook = files.find((f) => f.path === "hooks.server.ts")!;
    const imports = [
      ...hook.text.matchAll(/from\s+["']([^"']*\/integrations\/[^"']*)["']/g),
    ].map((m) => m[1]);
    expect(imports).toEqual([
      "$lib/server/integrations/paperless",
      "$lib/server/integrations/yahoo-finance",
    ]);
  });

  it("the core does not name Paperless in code outside the schema", () => {
    const offenders = files
      .filter((f) => !mayImportIntegrations(f.path))
      .filter((f) => !f.path.endsWith(".test.ts"))
      .filter((f) => f.path !== "lib/server/schema.ts")
      .filter((f) => /paperless/i.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
