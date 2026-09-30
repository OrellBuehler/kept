import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildXlsx, columnLetters } from "../../testing/fixtures/xlsx/build";
import { statementSheets } from "../../testing/fixtures/xlsx/generate";
import { fixture } from "../../testing/fixtures";
import { numberToPlainString, readXlsx, XLSX_LIMITS } from "./xlsx";
import { ImportFormatError } from "./types";

describe("numberToPlainString", () => {
  it.each([
    ["5200", "5200"],
    ["-4.5", "-4.5"],
    ["0.30000000000000004", "0.3"],
    ["1.5E-2", "0.015"],
    ["2.1E+26", "210000000000000000000000000"],
    ["1.23456789012345E+2", "123.456789012345"],
    ["-0.1", "-0.1"],
    ["100.10000000000001", "100.1"],
  ])("%s -> %s", (input, expected) => {
    expect(numberToPlainString(input)).toBe(expected);
  });
});

describe("readXlsx", () => {
  it("reads the first sheet with dates, exact numbers and strings", () => {
    const rows = readXlsx(fixture("xlsx/statement.xlsx"));
    expect(rows).toEqual([
      [
        "Date",
        "Counterparty",
        "Description",
        "Reference",
        "Amount",
        "Currency",
      ],
      ["2024-03-01", "Example Employer AG", "Salary March", "", "5200", "CHF"],
      ["2024-03-02", "Sample Cafe", "Coffee and cake", "", "-4.5", "CHF"],
      [
        "2024-03-03",
        "Demo Utilities GmbH",
        "Invoice 2024-117",
        "210000000003139471430009017",
        "-123.45",
        "CHF",
      ],
      ["2024-03-04", "Sample Shop", "Float artefact", "", "0.3", "CHF"],
      ["2024-03-05", "Example Bank", "Tiny exponent", "", "0.15", "CHF"],
      ["2024-03-06", "Sample Shop", "Zero", "", "0", "CHF"],
    ]);
  });

  it("renders numbers with the requested decimal separator", () => {
    const rows = readXlsx(fixture("xlsx/statement.xlsx"), {
      decimalSeparator: ",",
    });
    expect(rows[2]![4]).toBe("-4,5");
  });

  it("is reproducible: the committed fixture matches the generator", () => {
    expect(buildXlsx(statementSheets)).toEqual(fixture("xlsx/statement.xlsx"));
  });

  it("fills gaps for empty cells and rows", () => {
    const rows = readXlsx(
      buildXlsx([{ name: "S", rows: [["a", null, "c"], [], [null, "x"]] }]),
    );
    expect(rows).toEqual([["a", "", "c"], [], ["", "x"]]);
  });

  it("supports the 1904 date system", () => {
    const rows = readXlsx(
      buildXlsx([{ name: "S", rows: [[{ date: "2024-03-01" }]] }], {
        date1904: true,
      }),
    );
    expect(rows).toEqual([["2024-03-01"]]);
  });

  it("decodes XML entities and preserves whitespace", () => {
    const rows = readXlsx(
      buildXlsx([{ name: "S", rows: [["A & B <x>", " padded "]] }]),
    );
    expect(rows).toEqual([["A & B <x>", " padded "]]);
  });

  it("reads formula string results", () => {
    const rows = readXlsx(
      buildXlsx([{ name: "S", rows: [[{ formulaText: "computed" }]] }]),
    );
    expect(rows).toEqual([["computed"]]);
  });

  it("rejects non-xlsx input with a clear error", () => {
    expect(() => readXlsx(strToU8("Date,Amount\n"))).toThrow(
      /not an XLSX workbook/,
    );
    expect(() =>
      readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])),
    ).toThrow(/legacy \.xls/);
  });

  it("rejects a truncated archive", () => {
    const good = fixture("xlsx/statement.xlsx");
    expect(() => readXlsx(good.slice(0, 40))).toThrow(ImportFormatError);
  });

  it("rejects a zip without a worksheet", () => {
    const zip = zipSync({ "hello.txt": strToU8("hi") });
    expect(() => readXlsx(zip)).toThrow(/no worksheet/);
  });

  it("rejects parts that are too large when uncompressed (zip bomb)", () => {
    const big = new Uint8Array(XLSX_LIMITS.maxXmlBytes + 1);
    const zip = zipSync({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/worksheets/sheet1.xml": big,
    });
    expect(zip.length).toBeLessThan(1_000_000);
    expect(() => readXlsx(zip)).toThrow(/too large/);
  }, 60_000);

  it("rejects sparse sheets that would allocate huge rows", () => {
    const wide = buildXlsx([{ name: "S", rows: [["a"]] }], {
      cellRefs: () => "XFD1",
    });
    expect(() => readXlsx(wide)).toThrow(/exceeds 512 columns/);
  });

  it("rejects rows far beyond the row limit", () => {
    const zip = zipSync({
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="999999"><c r="A999999"><v>1</v></c></row></sheetData></worksheet>',
      ),
    });
    expect(() => readXlsx(zip)).toThrow(/exceeds 200000 rows/);
  });

  it("numbers columns like a spreadsheet", () => {
    expect(columnLetters(0)).toBe("A");
    expect(columnLetters(25)).toBe("Z");
    expect(columnLetters(26)).toBe("AA");
  });
});
