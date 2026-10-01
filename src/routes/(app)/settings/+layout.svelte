<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { cn } from "$lib/utils";
  import type { LayoutProps } from "./$types";

  let { children }: LayoutProps = $props();

  const tabs = [
    { href: resolve("/(app)/settings/account"), label: "Account" },
    { href: resolve("/(app)/settings/paperless"), label: "Paperless-ngx" },
  ];
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
