import { describe, expect, it } from "vitest";
import { guessProfile } from "./mapping-context";

describe("guessProfile", () => {
  it("never uses the date or amount columns as description", () => {
    const rows = [
      ["Buchungsdatum", "Valuta", "Buchungstext", "Betrag", "Waehrung"],
      ["01.03.2024", "01.03.2024", "Miete Maerz", "-1'850,00", "CHF"],
      ["05.03.2024", "05.03.2024", "Gehalt", "12'345,60", "CHF"],
    ];
    const c = guessProfile(rows, "CHF").columns as Record<string, unknown>;
    expect(c.bookingDate).toBe("Buchungsdatum");
    expect(c.amount).toBe("Betrag");
    expect(c.description).toBe("Buchungstext");
  });

  it("leaves description unset when only date and amount columns match", () => {
    const rows = [
      ["Buchungsdatum", "Betrag"],
      ["01.03.2024", "-10,00"],
    ];
    const c = guessProfile(rows, "CHF").columns as Record<string, unknown>;
    expect(c.description).toBeUndefined();
  });
});
