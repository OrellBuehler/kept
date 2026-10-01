import type { Component } from "svelte";
import GiftIcon from "@lucide/svelte/icons/gift";
import CarIcon from "@lucide/svelte/icons/car";
import FilmIcon from "@lucide/svelte/icons/film";
import GraduationCapIcon from "@lucide/svelte/icons/graduation-cap";
import HeartPulseIcon from "@lucide/svelte/icons/heart-pulse";
import HouseIcon from "@lucide/svelte/icons/house";
import PlaneIcon from "@lucide/svelte/icons/plane";
import ReceiptIcon from "@lucide/svelte/icons/receipt";
import ShieldIcon from "@lucide/svelte/icons/shield";
import ShoppingCartIcon from "@lucide/svelte/icons/shopping-cart";
import TagIcon from "@lucide/svelte/icons/tag";
import UtensilsIcon from "@lucide/svelte/icons/utensils";
import WalletIcon from "@lucide/svelte/icons/wallet";
import type { CategoryIcon } from "$lib/category-types";

export const CATEGORY_ICON_COMPONENTS: Record<CategoryIcon, Component> = {
  "shopping-cart": ShoppingCartIcon,
  house: HouseIcon,
  utensils: UtensilsIcon,
  car: CarIcon,
  "heart-pulse": HeartPulseIcon,
  plane: PlaneIcon,
  film: FilmIcon,
  "graduation-cap": GraduationCapIcon,
  shield: ShieldIcon,
  receipt: ReceiptIcon,
  wallet: WalletIcon,
  gift: GiftIcon,
};

export function categoryIcon(icon: string | null): Component {
  return (
    (icon && (CATEGORY_ICON_COMPONENTS as Record<string, Component>)[icon]) ||
    TagIcon
  );
}
