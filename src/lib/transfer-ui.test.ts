import { describe, expect, it } from "vitest";
import { outcomeFromParams, transferSummary } from "./transfer-ui";

describe("transferSummary", () => {
  it("is null when nothing happened", () => {
    expect(transferSummary({ linked: 0, mirrored: 0, needsAmount: 0 })).toBe(
      null,
    );
  });

  it("lists only what happened, with plurals", () => {
    expect(transferSummary({ linked: 1, mirrored: 0, needsAmount: 0 })).toBe(
      "1 transfer linked",
    );
    expect(transferSummary({ linked: 2, mirrored: 3, needsAmount: 1 })).toBe(
      "2 transfers linked, 3 transactions filled in, 1 transfer needs an amount",
    );
    expect(transferSummary({ linked: 0, mirrored: 1, needsAmount: 2 })).toBe(
      "1 transaction filled in, 2 transfers need an amount",
    );
  });
});

describe("outcomeFromParams", () => {
  it("reads counts and ignores junk", () => {
    expect(
      outcomeFromParams(
        new URLSearchParams("imported=x&linked=2&mirrored=abc&needsAmount=-1"),
      ),
    ).toEqual({ linked: 2, mirrored: 0, needsAmount: 0 });
  });
});
