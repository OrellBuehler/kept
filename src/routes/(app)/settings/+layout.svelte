<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { cn } from "$lib/utils";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();

  // Each settings page declares its tab in `<page>/tab.ts`; the core layout does not know them by name.
  const modules = import.meta.glob<{ tab: { label: string; order: number } }>(
    "./*/tab.ts",
    { eager: true },
  );
  const tabs = Object.entries(modules)
    .map(([path, m]) => ({
      href: resolve(
        `/(app)/settings/${path.split("/")[1]}` as "/(app)/settings/account",
      ),
      ...m.tab,
    }))
    .sort((a, b) => a.order - b.order);
</script>

<nav
  aria-label="Settings"
  class="mb-6 flex [scrollbar-width:none] gap-1 overflow-x-auto border-b"
>
  {#each tabs as tab (tab.href)}
    {@const active = page.url.pathname.startsWith(tab.href)}
    <a
      href={tab.href}
      aria-current={active ? "page" : undefined}
      class={cn(
        "focus-visible:ring-ring/50 -mb-px shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-[3px]",
        active
          ? "border-primary text-foreground"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {tab.label}
    </a>
  {/each}
</nav>

{@render children()}
