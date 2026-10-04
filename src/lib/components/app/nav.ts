import type { Component } from "svelte";

export type NavHref =
  | "/"
  | "/accounts"
  | "/investments"
  | "/pillar-3a"
  | "/import"
  | "/bills"
  | "/budgets"
  | "/forecast"
  | "/recurring"
  | "/taxes"
  | "/review"
  | "/reports"
  | "/settings/account"
  | "/admin/users"
  | "/admin/backup";

export type NavItem = {
  href: NavHref;
  label: string;
  icon: Component;
  badge?: number;
};
