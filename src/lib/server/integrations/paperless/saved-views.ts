import { z } from "zod";

export const savedViewRuleSchema = z.object({
  rule_type: z.number().int(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
});
export type SavedViewRule = z.infer<typeof savedViewRuleSchema>;

type Kind = "multi" | "bool" | "int" | "text" | "date" | "json";

interface RuleSpec {
  param: string;
  kind: Kind;
}

/** Paperless-ngx web UI filter rule types -> document list query parameters. */
const RULES: Record<number, RuleSpec> = {
  0: { param: "title__icontains", kind: "text" },
  1: { param: "content__icontains", kind: "text" },
  2: { param: "archive_serial_number", kind: "int" },
  3: { param: "correspondent__id", kind: "int" },
  4: { param: "document_type__id", kind: "int" },
  5: { param: "is_in_inbox", kind: "bool" },
  6: { param: "tags__id__all", kind: "multi" },
  7: { param: "is_tagged", kind: "bool" },
  8: { param: "created__date__lt", kind: "date" },
  9: { param: "created__date__gt", kind: "date" },
  10: { param: "created__year", kind: "int" },
  11: { param: "created__month", kind: "int" },
  12: { param: "created__day", kind: "int" },
  13: { param: "added__date__lt", kind: "date" },
  14: { param: "added__date__gt", kind: "date" },
  15: { param: "modified__date__lt", kind: "date" },
  16: { param: "modified__date__gt", kind: "date" },
  17: { param: "tags__id__none", kind: "multi" },
  18: { param: "archive_serial_number__isnull", kind: "bool" },
  19: { param: "text", kind: "text" },
  22: { param: "tags__id__in", kind: "multi" },
  23: { param: "archive_serial_number__gt", kind: "int" },
  24: { param: "archive_serial_number__lt", kind: "int" },
  25: { param: "storage_path__id", kind: "int" },
  26: { param: "correspondent__id__in", kind: "multi" },
  27: { param: "correspondent__id__none", kind: "multi" },
  28: { param: "document_type__id__in", kind: "multi" },
  29: { param: "document_type__id__none", kind: "multi" },
  30: { param: "storage_path__id__in", kind: "multi" },
  31: { param: "storage_path__id__none", kind: "multi" },
  32: { param: "owner__id", kind: "int" },
  33: { param: "owner__id__in", kind: "multi" },
  34: { param: "owner__isnull", kind: "bool" },
  35: { param: "owner__id__none", kind: "multi" },
  38: { param: "custom_fields__id__all", kind: "multi" },
  39: { param: "custom_fields__id__in", kind: "multi" },
  40: { param: "custom_fields__id__none", kind: "multi" },
  41: { param: "has_custom_fields", kind: "bool" },
  42: { param: "custom_field_query", kind: "json" },
  43: { param: "created__date__lte", kind: "date" },
  44: { param: "created__date__gte", kind: "date" },
  45: { param: "added__date__lte", kind: "date" },
  46: { param: "added__date__gte", kind: "date" },
  47: { param: "mime_type", kind: "text" },
  48: { param: "title_search", kind: "text" },
  49: { param: "text", kind: "text" },
};

const UNSUPPORTED_NAMES: Record<number, string> = {
  20: "full-text query",
  21: "more like this",
  36: "custom field text",
  37: "shared by me",
};

export type Translation =
  { ok: true; query: Array<[string, string]> } | { ok: false; message: string };

function convert(spec: RuleSpec, raw: string | null): string | null {
  if (raw === null) return null;
  switch (spec.kind) {
    case "bool":
      if (raw === "true" || raw === "1") return "1";
      if (raw === "false" || raw === "0") return "0";
      return null;
    case "int":
      return /^-?\d{1,12}$/.test(raw) ? raw : null;
    case "multi": {
      const parts = raw.split(",").map((p) => p.trim());
      return parts.length > 0 && parts.every((p) => /^\d{1,12}$/.test(p))
        ? parts.join(",")
        : null;
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    case "json":
      try {
        JSON.parse(raw);
      } catch {
        return null;
      }
      return raw;
    case "text":
      return raw.length > 0 && raw.length <= 500 ? raw : null;
  }
}

/**
 * Translates a saved view's filter rules into document list query parameters,
 * like the Paperless web UI does. Unsupported rules are rejected so a view is
 * never silently widened.
 */
export function translateFilterRules(
  rules: readonly SavedViewRule[],
): Translation {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    const spec = RULES[rule.rule_type];
    if (!spec) {
      const name = UNSUPPORTED_NAMES[rule.rule_type];
      return {
        ok: false,
        message: name
          ? `This saved view uses a filter Kept cannot apply (${name}). Choose another view or a tag.`
          : `This saved view uses an unknown filter (type ${rule.rule_type}). Choose another view or a tag.`,
      };
    }
    const raw =
      rule.value === undefined || rule.value === null
        ? null
        : String(rule.value);
    const value = convert(spec, raw);
    if (value === null) {
      return {
        ok: false,
        message: `This saved view has a filter value Kept cannot apply (filter type ${rule.rule_type}). Relative dates and empty values are not supported.`,
      };
    }
    const previous = merged.get(spec.param);
    if (previous !== undefined && spec.kind === "multi") {
      merged.set(spec.param, `${previous},${value}`);
    } else {
      merged.set(spec.param, value);
    }
  }
  return { ok: true, query: [...merged] };
}
