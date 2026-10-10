import type { Component } from "svelte";

export type NavHref =
  | "/(app)"
  | "/(app)/accounts"
  | "/(app)/investments"
  | "/(app)/pillar-3a"
  | "/(app)/import"
  | "/(app)/bills"
  | "/(app)/budgets"
  | "/(app)/forecast"
  | "/(app)/recurring"
  | "/(app)/taxes"
  | "/(app)/review"
  | "/(app)/reports"
  | "/(app)/settings/account"
  | "/(app)/admin/users"
  | "/(app)/admin/backup";

export type NavItem = {
  href: NavHref;
  label: string;
  icon: Component;
  badge?: number;
};
