export const CATEGORY_KINDS = ["expense", "income"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const AMOUNT_SIGNS = ["income", "expense"] as const;
export type AmountSign = (typeof AMOUNT_SIGNS)[number];

export const CATEGORY_ICONS = [
  "shopping-cart",
  "house",
  "utensils",
  "car",
  "heart-pulse",
  "plane",
  "film",
  "graduation-cap",
  "shield",
  "receipt",
  "wallet",
  "gift",
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface CategoryOption {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  color: string | null;
  icon: string | null;
}

/** "Parent / Child" for subcategories, otherwise the name. */
export function categoryLabel(
  category: Pick<CategoryOption, "id" | "name" | "parentId">,
  all: readonly Pick<CategoryOption, "id" | "name">[],
): string {
  const parent = category.parentId
    ? all.find((c) => c.id === category.parentId)
    : undefined;
  return parent ? `${parent.name} / ${category.name}` : category.name;
}
