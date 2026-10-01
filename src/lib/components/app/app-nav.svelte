<script lang="ts">
  import { resolve } from "$app/paths";
  import type { NavItem } from "./nav";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";

  let {
    items,
    isActive,
  }: { items: NavItem[]; isActive: (href: string) => boolean } = $props();

  const sidebar = Sidebar.useSidebar();
</script>

<Sidebar.Menu>
  {#each items as item (item.href)}
    <Sidebar.MenuItem>
      <Sidebar.MenuButton
        isActive={isActive(item.href)}
        tooltipContent={item.label}
        class="text-sidebar-foreground/80 data-[active=true]:[&>svg]:text-sidebar-primary h-9 transition-colors"
      >
        {#snippet child({ props })}
          <a
            href={resolve(item.href)}
            {...props}
            aria-current={isActive(item.href) ? "page" : undefined}
            aria-label={item.badge
              ? `${item.label}, ${item.badge} overdue`
              : undefined}
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
          aria-hidden="true"
        >
          {item.badge > 99 ? "99+" : item.badge}
        </Sidebar.MenuBadge>
      {/if}
    </Sidebar.MenuItem>
  {/each}
</Sidebar.Menu>
