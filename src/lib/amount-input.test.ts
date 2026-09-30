import { describe, expect, it } from "vitest";
import { minorToInput, minorToSignedInput } from "./amount-input";

describe("minorToInput", () => {
  it("formats by currency exponent", () => {
    expect(minorToInput(123450, "CHF")).toBe("1234.50");
    expect(minorToInput(-5, "CHF")).toBe("0.05");
    expect(minorToInput(700, "JPY")).toBe("700");
    expect(minorToInput(1234, "KWD")).toBe("1.234");
  });
  it("keeps the sign when asked", () => {
    expect(minorToSignedInput(-1250, "CHF")).toBe("-12.50");
    expect(minorToSignedInput(1250, "CHF")).toBe("12.50");
  });
});
