import { describe, expect, it } from "vitest";
import {
  hasControlOrSpace,
  isSafeLinkUrl,
  normalizeLinkUrl,
} from "./external-links";

describe("normalizeLinkUrl", () => {
  it("accepts http and https and returns the normalised form", () => {
    expect(normalizeLinkUrl("https://example.org")).toBe(
      "https://example.org/",
    );
    expect(normalizeLinkUrl(" http://Example.org:8080/a?b=1#c ")).toBe(
      "http://example.org:8080/a?b=1#c",
    );
    expect(normalizeLinkUrl("https://192.0.2.1/x")).toBe("https://192.0.2.1/x");
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "javascript:alert(1)",
      "data:text/plain,hi",
      "mailto:a@example.org",
      "ftp://example.org",
      "//example.org",
      "/path",
      "https://u:p@example.org",
      "https://example.org/a b",
      "https://example.org/\u0000",
      "https:///",
      "https:///x",
      "https:\\\\example.org",
      "https:example.org",
      "https://?x",
    ]) {
      expect(normalizeLinkUrl(bad), bad).toBeNull();
      expect(isSafeLinkUrl(bad), bad).toBe(false);
    }
  });
});

describe("hasControlOrSpace", () => {
  it("flags control, C1 and invisible format characters", () => {
    for (const bad of [
      "a\nb",
      "a\u0085b",
      "a\u202Eb",
      "a\u200Bb",
      "a\u2066b",
    ]) {
      expect(hasControlOrSpace(bad), JSON.stringify(bad)).toBe(true);
    }
    expect(hasControlOrSpace("Apartment costs ä")).toBe(false);
    expect(hasControlOrSpace("a b")).toBe(false);
    expect(hasControlOrSpace("a b", true)).toBe(true);
  });
});
