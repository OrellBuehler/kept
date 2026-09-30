import { describe, expect, it } from "vitest";
import { translateFilterRules } from "./saved-views";

const t = (...rules: Array<[number, string | null]>) =>
  translateFilterRules(
    rules.map(([rule_type, value]) => ({ rule_type, value })),
  );

describe("translateFilterRules", () => {
  it("translates tag, correspondent and date rules", () => {
    expect(
      t([6, "3"], [3, "7"], [9, "2026-01-01"], [46, "2026-02-01"]),
    ).toEqual({
      ok: true,
      query: [
        ["tags__id__all", "3"],
        ["correspondent__id", "7"],
        ["created__date__gt", "2026-01-01"],
        ["added__date__gte", "2026-02-01"],
      ],
    });
  });

  it("merges repeated multi-value rules and keeps comma lists", () => {
    expect(t([6, "1"], [6, "2,3"], [17, "9"])).toEqual({
      ok: true,
      query: [
        ["tags__id__all", "1,2,3"],
        ["tags__id__none", "9"],
      ],
    });
  });

  it("converts boolean rules to 1/0", () => {
    expect(t([5, "true"], [7, "false"], [41, "1"])).toEqual({
      ok: true,
      query: [
        ["is_in_inbox", "1"],
        ["is_tagged", "0"],
        ["has_custom_fields", "1"],
      ],
    });
  });

  it("passes custom field queries through when they are JSON", () => {
    const query = '["7","exists",true]';
    expect(t([42, query])).toEqual({
      ok: true,
      query: [["custom_field_query", query]],
    });
    expect(t([42, "{not json"]).ok).toBe(false);
  });

  it("accepts an empty rule list (all documents)", () => {
    expect(t()).toEqual({ ok: true, query: [] });
  });

  it("rejects rules Kept cannot apply, naming the reason", () => {
    for (const [type, word] of [
      [20, "full-text"],
      [21, "more like this"],
      [37, "shared by me"],
    ] as const) {
      const r = t([type, "x"]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(word);
    }
    const unknown = t([999, "x"]);
    expect(unknown.ok).toBe(false);
  });

  it("rejects relative dates, empty and malformed values", () => {
    expect(t([9, "-1 week to now"]).ok).toBe(false);
    expect(t([6, null]).ok).toBe(false);
    expect(t([6, "a,b"]).ok).toBe(false);
    expect(t([5, "maybe"]).ok).toBe(false);
    expect(t([2, "12x"]).ok).toBe(false);
  });
});
