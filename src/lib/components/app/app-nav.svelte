<script lang="ts">
  import type { Component } from "svelte";
  import { resolve } from "$app/paths";
  import type { Pathname } from "$app/types";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";

  type Item = {
    href: Pathname;
    label: string;
    icon: Component;
    badge?: number;
  };
  let {
    items,
    isActive,
  }: { items: Item[]; isActive: (href: string) => boolean } = $props();

  const sidebar = Sidebar.useSidebar();
</script>

<Sidebar.Menu>
  {#each items as item (item.href)}
    <Sidebar.MenuItem>
      <Sidebar.MenuButton
        isActive={isActive(item.href)}
        tooltipContent={item.label}
      >
        {#snippet child({ props })}
          <a
            href={resolve(item.href)}
            {...props}
            aria-current={isActive(item.href) ? "page" : undefined}
            onclick={() => sidebar.setOpenMobile(false)}
          >
            <item.icon />
            <span>{item.label}</span>
          </a>
        {/snippet}
      </Sidebar.MenuButton>
      {#if item.badge}
        <Sidebar.MenuBadge
          class="bg-destructive text-white peer-hover/menu-button:text-white peer-data-[active=true]/menu-button:text-white"
          aria-label={`${item.badge} overdue`}
        >
          {item.badge}
        </Sidebar.MenuBadge>
      {/if}
    </Sidebar.MenuItem>
  {/each}
</Sidebar.Menu>
