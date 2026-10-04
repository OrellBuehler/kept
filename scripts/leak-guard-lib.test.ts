import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  decodeXmlEntities,
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

describe("normalization", () => {
  it("matches across unicode normalization forms", () => {
    expect(scan("Zu\u0308rich", "Z\u00fcrich")).toEqual([1]);
    expect(scan("Z\u00fcrich", "Zu\u0308rich")).toEqual([1]);
  });

  it("ignores zero-width characters in text and terms", () => {
    expect(scan("Foo\u200B AG", "Foo AG")).toEqual([1]);
    expect(scan("Fo\u2060o\uFEFF AG", "Foo AG")).toEqual([1]);
    expect(scan("Foo AG", "Fo\u200Do AG")).toEqual([1]);
  });

  it("decodes numeric and named entities in markup", () => {
    const patterns = [termRegex("Foo & Bar AG"), termRegex("Zürich")];
    const warn = () => {};
    const zip = zipSync({
      "a.xml": strToU8("<t>Foo &amp; Bar AG</t>\n<t>Z&#252;rich</t>"),
      "b.xml": strToU8("<t>Z&#xFC;rich</t>"),
      "c.xml": strToU8("<t>Foo &#38; Bar&#x20;AG</t>"),
    });
    const found = scanFile("s.zip", zip, patterns, warn).map((f) => f.location);
    expect(found).toContain("s.zip!a.xml:1");
    expect(found).toContain("s.zip!a.xml:2");
    expect(found).toContain("s.zip!b.xml:1");
    expect(found).toContain("s.zip!c.xml:1");
  });

  it("leaves invalid entities untouched", () => {
    expect(decodeXmlEntities("&#99999999; &bogus; &amp;")).toBe(
      "&#99999999; &bogus; &",
    );
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

  describe("zip limits", () => {
    const limits = { maxEntryBytes: 1000, maxTotalBytes: 2500, maxEntries: 5 };
    const zeros = (n: number) => new Uint8Array(n);

    it("reports an oversize entry as a problem naming the file", () => {
      const zip = zipSync({ "big.xml": zeros(1_000_000) });
      expect(zip.length).toBeLessThan(5000);
      const found = scanFile("bomb.zip", zip, patterns, warn, limits);
      expect(found).toHaveLength(1);
      expect(found[0].location).toBe("bomb.zip!big.xml");
      expect(found[0].problem).toContain("exceeds");
    });

    it("enforces the total budget across nested archives", () => {
      const inner = zipSync({ "a.txt": zeros(900), "b.txt": zeros(900) });
      const outer = zipSync({ "i1.zip": inner, "i2.zip": inner });
      const found = scanFile("o.zip", outer, patterns, warn, limits);
      expect(found.some((f) => f.problem?.includes("total"))).toBe(true);
    });

    it("enforces the entry count across levels", () => {
      const inner = zipSync({
        "a.txt": zeros(1),
        "b.txt": zeros(1),
        "c.txt": zeros(1),
      });
      const outer = zipSync({ "i1.zip": inner, "i2.zip": inner });
      const found = scanFile("o.zip", outer, patterns, warn, limits);
      expect(found.some((f) => f.problem?.includes("entry count"))).toBe(true);
    });

    it("does not report archives within limits", () => {
      const zip = zipSync({ "a.txt": strToU8("fine") });
      expect(scanFile("ok.zip", zip, patterns, warn, limits)).toEqual([]);
    });
  });
});
