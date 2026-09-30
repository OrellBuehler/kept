<script lang="ts">
  import type { Component } from "svelte";
  import { resolve } from "$app/paths";
  import type { Pathname } from "$app/types";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";

  type Item = { href: string; label: string; icon: Component };
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
            href={resolve(item.href as Pathname)}
            {...props}
            aria-current={isActive(item.href) ? "page" : undefined}
            onclick={() => sidebar.setOpenMobile(false)}
          >
            <item.icon />
            <span>{item.label}</span>
          </a>
        {/snippet}
      </Sidebar.MenuButton>
    </Sidebar.MenuItem>
  {/each}
</Sidebar.Menu>
