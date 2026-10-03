import type { Component } from "svelte";

export type NavHref =
  | "/"
  | "/accounts"
  | "/import"
  | "/bills"
  | "/budgets"
  | "/forecast"
  | "/taxes"
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
