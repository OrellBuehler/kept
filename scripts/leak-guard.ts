#!/usr/bin/env bun
/**
 * Blocks private data from reaching this public repository.
 *
 * Private terms (names of your banks, employers, people, addresses, ...) are read from
 * `.private-terms` (gitignored, one term per line, `#` comments) or from the
 * KEPT_PRIVATE_TERMS environment variable (newline-separated, used in CI via a secret).
 *
 * Usage:
 *   bun scripts/leak-guard.ts <files...>   check the given files (pre-commit / commit-msg)
 *   bun scripts/leak-guard.ts --all        check every tracked or unignored file
 */
import { existsSync, readFileSync } from "node:fs";

const TERMS_FILE = ".private-terms";

function loadTerms(): string[] {
  const sources: string[] = [];
  if (existsSync(TERMS_FILE)) sources.push(readFileSync(TERMS_FILE, "utf8"));
  if (process.env.KEPT_PRIVATE_TERMS)
    sources.push(process.env.KEPT_PRIVATE_TERMS);
  return sources
    .flatMap((s) => s.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync([
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (result.exitCode !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString().split("\0").filter(Boolean);
}

const args = process.argv.slice(2);
const files = (args.includes("--all") ? trackedFiles() : args).filter(
  (f) => f !== TERMS_FILE && existsSync(f),
);

const terms = loadTerms();
if (terms.length === 0) {
  console.warn(
    `leak-guard: no private terms configured (${TERMS_FILE} or KEPT_PRIVATE_TERMS); only structural checks run.`,
  );
}

// Never print the term itself: CI logs of a public repository are public.
const patterns: { label: string; regex: RegExp }[] = terms.map(
  (term, index) => ({
    label: `private term #${index + 1}`,
    regex: new RegExp(`\\b${escapeRegex(term)}\\b`, "i"),
  }),
);

const findings: string[] = [];
for (const file of files) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const lines = buffer.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    for (const { label, regex } of patterns) {
      if (regex.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
    }
  });
}

if (findings.length > 0) {
  console.error(
    "leak-guard: private data found — remove it before committing:\n",
  );
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
