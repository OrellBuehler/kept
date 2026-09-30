import { describe, expect, it } from "vitest";
import { fixture } from "../../testing/fixtures";
import { decodeText, detectDelimiter, parseCsvText, readCsv } from "./tabular";
import { ImportFormatError } from "./types";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("parseCsvText", () => {
  it("handles quotes, escaped quotes, embedded delimiters and newlines", () => {
    const rows = parseCsvText('a,"b,1","say ""hi""","x\ny"\nlast,,"",z\n', ",");
    expect(rows).toEqual([
      ["a", "b,1", 'say "hi"', "x\ny"],
      ["last", "", "", "z"],
    ]);
  });

  it("accepts CRLF, LF and CR line endings", () => {
    expect(parseCsvText("a,b\r\nc,d\re,f\ng,h", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("keeps blank lines as [''] and ignores a trailing newline", () => {
    expect(parseCsvText("a\n\nb\n", ",")).toEqual([["a"], [""], ["b"]]);
    expect(parseCsvText("", ",")).toEqual([]);
  });

  it("treats quotes inside unquoted fields literally", () => {
    expect(parseCsvText('5" pipe,x', ",")).toEqual([['5" pipe', "x"]]);
  });

  it("keeps a trailing empty field", () => {
    expect(parseCsvText("a,b,\n", ",")).toEqual([["a", "b", ""]]);
  });

  it("rejects an unterminated quoted field", () => {
    expect(() => parseCsvText('a,b\nc,"open\nd,e', ",")).toThrow(
      /Unterminated quoted field starting in record 2/,
    );
  });
});

describe("decodeText", () => {
  it("strips a UTF-8 BOM", () => {
    const b = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("Café")]);
    expect(decodeText(b)).toBe("Café");
    expect(decodeText(b, "utf-8")).toBe("Café");
  });

  it("falls back to windows-1252 for invalid UTF-8 in auto mode", () => {
    expect(decodeText(new Uint8Array([0x42, 0xe4, 0xf6, 0xfc]))).toBe("Bäöü");
    expect(decodeText(new Uint8Array([0x80]), "windows-1252")).toBe("€");
  });

  it("rejects invalid UTF-8 when utf-8 is requested explicitly", () => {
    expect(() => decodeText(new Uint8Array([0xe4]), "utf-8")).toThrow(
      ImportFormatError,
    );
  });

  it("decodes UTF-16 LE and BE with BOM, and explicit utf-16le", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0, 0xe4, 0]))).toBe(
      "aä",
    );
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x61, 0, 0xe4]))).toBe(
      "aä",
    );
    expect(decodeText(new Uint8Array([0x61, 0, 0xe4, 0]), "utf-16le")).toBe(
      "aä",
    );
  });

  it("detects UTF-16 without BOM in auto mode", () => {
    const le = new Uint8Array([0x41, 0, 0x62, 0, 0xe4, 0, 0x0a, 0]);
    const be = new Uint8Array([0, 0x41, 0, 0x62, 0, 0xe4, 0, 0x0a]);
    expect(decodeText(le)).toBe("Abä\n");
    expect(decodeText(be)).toBe("Abä\n");
  });

  it("decodes iso-8859-1", () => {
    expect(decodeText(new Uint8Array([0xe4, 0xdf]), "iso-8859-1")).toBe("äß");
  });
});

describe("detectDelimiter", () => {
  it("detects semicolon with decimal commas", () => {
    expect(detectDelimiter("a;b;c\n1;2,5;3\n4;5,5;6\n")).toBe(";");
  });

  it("detects comma, tab and pipe", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
  });

  it("ignores delimiters inside quotes and single-column preambles", () => {
    expect(detectDelimiter('Export\n\na;b\n"1,5";"2,5"\n"3,5";"4,5"\n')).toBe(
      ";",
    );
  });

  it("defaults to comma for single-column input", () => {
    expect(detectDelimiter("a\nb\n")).toBe(",");
  });
});

describe("readCsv fixtures", () => {
  it("reads windows-1252 umlauts", () => {
    const rows = readCsv(fixture("csv/windows-1252-umlauts.csv"));
    expect(rows[1]).toEqual(["01.04.2024", "Bäckerei Müller", "-8,40"]);
    expect(rows[2]![1]).toBe("Schönenberg Öl AG");
  });

  it("strips the BOM of UTF-8 files so the first header is clean", () => {
    const rows = readCsv(fixture("csv/utf8-bom.csv"));
    expect(rows[0]![0]).toBe("Date");
    expect(rows[1]![1]).toBe("Café Zürich");
  });

  it("reads UTF-16 LE with tab delimiter and CRLF", () => {
    expect(readCsv(fixture("csv/utf16le-bom.csv"))).toEqual([
      ["Date", "Text", "Amount"],
      ["2024-04-01", "Äpfel & Birnen", "-3.10"],
    ]);
  });

  it("honours an explicit delimiter over detection", () => {
    expect(readCsv(bytes("a;b,c\n"), { delimiter: ";" })).toEqual([
      ["a", "b,c"],
    ]);
  });
});
