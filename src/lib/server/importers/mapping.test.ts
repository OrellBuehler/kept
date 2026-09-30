import { describe, expect, it } from "vitest";
import { parseMappingProfile } from "./mapping";

const valid = {
  amountMode: "single",
  defaultCurrency: "chf",
  columns: { bookingDate: "Date", amount: "Amount" },
};

describe("csvMappingProfileSchema", () => {
  it("applies defaults and normalizes", () => {
    const p = parseMappingProfile(valid);
    expect(p).toMatchObject({
      delimiter: "auto",
      encoding: "auto",
      headerRow: 1,
      skipFooterRows: 0,
      dateFormat: "YYYY-MM-DD",
      decimalSeparator: ".",
      thousandsSeparator: "",
      invertSign: false,
      defaultCurrency: "CHF",
    });
  });

  it("turns a single description column into a list", () => {
    const p = parseMappingProfile({
      ...valid,
      columns: { ...valid.columns, description: "Text" },
    });
    expect(p.columns.description).toEqual(["Text"]);
    const q = parseMappingProfile({
      ...valid,
      columns: { ...valid.columns, description: ["Text", 4] },
    });
    expect(q.columns.description).toEqual(["Text", 4]);
  });

  it.each([
    [
      "single without amount",
      { ...valid, columns: { bookingDate: "Date" } },
      "columns.amount",
    ],
    [
      "indicator mode without indicator",
      { ...valid, amountMode: "single_with_indicator" },
      "columns.indicator",
    ],
    [
      "split without credit or debit",
      { ...valid, amountMode: "split" },
      "credit and/or",
    ],
    [
      "no currency source",
      { ...valid, defaultCurrency: undefined },
      "defaultCurrency is required",
    ],
    [
      "equal separators",
      { ...valid, decimalSeparator: ".", thousandsSeparator: "." },
      "differ",
    ],
    [
      "named column without header",
      { ...valid, headerRow: 0 },
      "addressed by name",
    ],
    [
      "original amount without currency",
      { ...valid, columns: { ...valid.columns, originalAmount: "X" } },
      "mapped together",
    ],
    ["bad delimiter", { ...valid, delimiter: "x" }, "delimiter"],
    ["bad currency", { ...valid, defaultCurrency: "CHFX" }, "3-letter"],
  ])("rejects %s", (_name, input, message) => {
    expect(() => parseMappingProfile(input)).toThrow(message);
  });

  it("accepts index addressing without a header", () => {
    const p = parseMappingProfile({
      ...valid,
      headerRow: 0,
      columns: { bookingDate: 0, amount: "2" },
    });
    expect(p.headerRow).toBe(0);
  });
});
