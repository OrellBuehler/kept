import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  scanFile,
  scanText,
  termRegex,
} from "./leak-guard-lib";

const scan = (text: string, term: string) => scanText(text, [termRegex(term)]);

describe("termRegex", () => {
  it("matches whole words case-insensitively", () => {
    expect(scan("pay Example Corp today", "example corp")).toEqual([1]);
    expect(scan("Example Corporation", "Example Corp")).toEqual([]);
    expect(scan("xExample Corp", "Example Corp")).toEqual([]);
  });

  it("matches terms that start or end with an accented letter", () => {
    expect(scan("Cafe Zürich", "Zürich")).toEqual([1]);
    expect(scan("see Élan here", "Élan")).toEqual([1]);
    expect(scan("see élan here", "Élan")).toEqual([1]);
    expect(scan("Zürichsee", "Zürich")).toEqual([]);
    expect(scan("Xélan", "élan")).toEqual([]);
  });

  it("treats digits and underscores as word characters", () => {
    expect(scan("acme_1", "acme")).toEqual([]);
    expect(scan("acme-1", "acme")).toEqual([1]);
  });

  it("escapes regex metacharacters", () => {
    expect(scan("Foo (Bar) Ltd.", "Foo (Bar) Ltd.")).toEqual([1]);
    expect(scan("Foo xBarx Ltd.", "Foo (Bar) Ltd.")).toEqual([]);
  });
});

describe("whitespace", () => {
  it("collapses runs of whitespace", () => {
    expect(collapseWhitespace("  a \t  b  c ")).toBe("a b c");
  });

  it("matches across differing whitespace in terms and text", () => {
    expect(scan("Foo  AG", "Foo AG")).toEqual([1]);
    expect(scan("Foo AG", "Foo   AG")).toEqual([1]);
    expect(scan("a\nFoo\t AG", "Foo AG")).toEqual([2]);
  });
});

describe("scanFile", () => {
  const patterns = [termRegex("Foo AG")];
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  it("scans plain text", () => {
    const found = scanFile("a.txt", strToU8("x\nFoo  AG"), patterns, warn);
    expect(found).toEqual([{ location: "a.txt:2", patternIndex: 0 }]);
  });

  it("skips non-zip binary files", () => {
    expect(
      scanFile("a.bin", new Uint8Array([0, 70, 111, 111]), patterns, warn),
    ).toEqual([]);
  });

  it("scans xml parts inside zip archives, including text split across tags", () => {
    const zip = zipSync({
      "xl/sharedStrings.xml": strToU8("<si><t>Foo</t><t> AG</t></si>"),
      "xl/other.xml": strToU8("<si><t>nothing</t></si>"),
    });
    const found = scanFile("s.xlsx", zip, patterns, warn);
    expect(found).toEqual([
      { location: "s.xlsx!xl/sharedStrings.xml:1", patternIndex: 0 },
    ]);
  });

  it("scans nested archives", () => {
    const inner = zipSync({ "a.txt": strToU8("Foo AG") });
    const outer = zipSync({ "inner.zip": inner });
    expect(scanFile("o.zip", outer, patterns, warn)).toEqual([
      { location: "o.zip!inner.zip!a.txt:1", patternIndex: 0 },
    ]);
  });

  it("warns instead of silently skipping a corrupt archive", () => {
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(scanFile("bad.zip", corrupt, patterns, warn)).toEqual([]);
    expect(warnings.some((w) => w.includes("bad.zip"))).toBe(true);
  });
});
