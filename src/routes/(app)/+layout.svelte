<script lang="ts">
  import { page } from "$app/state";
  import { resolve, asset } from "$app/paths";
  import { cn } from "$lib/utils";
  import { userPrefersMode, setMode } from "mode-watcher";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import LandmarkIcon from "@lucide/svelte/icons/landmark";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import PiggyBankIcon from "@lucide/svelte/icons/piggy-bank";
  import ReceiptIcon from "@lucide/svelte/icons/receipt";
  import TrendingUpIcon from "@lucide/svelte/icons/trending-up";
  import ScaleIcon from "@lucide/svelte/icons/scale";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import UsersIcon from "@lucide/svelte/icons/users";
  import DatabaseBackupIcon from "@lucide/svelte/icons/database-backup";
  import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
  import LogOutIcon from "@lucide/svelte/icons/log-out";
  import SunIcon from "@lucide/svelte/icons/sun";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import MonitorIcon from "@lucide/svelte/icons/monitor";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import AppNav from "$lib/components/app/app-nav.svelte";
  import type { NavItem } from "$lib/components/app/nav";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  const nav: NavItem[] = $derived([
    { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
    { href: "/accounts", label: "Accounts", icon: LandmarkIcon },
    { href: "/import", label: "Import", icon: UploadIcon },
    {
      href: "/bills",
      label: "Bills",
      icon: ReceiptIcon,
      badge: data.overdueBills,
    },
    { href: "/budgets", label: "Budgets", icon: PiggyBankIcon },
    { href: "/forecast", label: "Forecast", icon: TrendingUpIcon },
    { href: "/taxes", label: "Taxes", icon: ScaleIcon },
    { href: "/reports", label: "Reports", icon: FileTextIcon },
    { href: "/settings/account", label: "Settings", icon: SettingsIcon },
    ...(data.user.role === "admin"
      ? [
          { href: "/admin/users" as const, label: "Users", icon: UsersIcon },
          {
            href: "/admin/backup" as const,
            label: "Backup",
            icon: DatabaseBackupIcon,
          },
        ]
      : []),
  ]);

  function isActive(href: string) {
    const path = page.url.pathname;
    if (href === "/") return path === "/";
    if (href === "/settings/account") return path.startsWith("/settings");
    return path === href || path.startsWith(href + "/");
  }

  const name = $derived(data.user.displayName || data.user.username);
  const initial = $derived(name.charAt(0).toUpperCase());

  const modes = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: MonitorIcon },
  ] as const;
</script>

<Sidebar.Provider>
  <Sidebar.Root collapsible="icon">
    <Sidebar.Header>
      <a
        href={resolve("/")}
        class="ring-sidebar-ring flex h-11 items-center rounded-md px-2 outline-hidden transition-opacity hover:opacity-80 focus-visible:ring-2"
        aria-label="Kept, go to dashboard"
      >
        <img
          src={asset("/brand/kept-symbol-small.svg")}
          alt=""
          class="size-6 shrink-0 dark:invert"
        />
        <span
          class="ms-2 text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden"
          >Kept</span
        >
      </a>
    </Sidebar.Header>
    <Sidebar.Content>
      <Sidebar.Group>
        <Sidebar.GroupContent>
          <AppNav items={nav} {isActive} />
        </Sidebar.GroupContent>
      </Sidebar.Group>
    </Sidebar.Content>
    <Sidebar.Footer>
      <Sidebar.Menu>
        <Sidebar.MenuItem>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Sidebar.MenuButton
                  {...props}
                  size="lg"
                  class="data-[state=open]:bg-sidebar-accent"
                >
                  <span
                    class="from-brand to-chart-2 text-brand-foreground shadow-card flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-sm font-semibold"
                    aria-hidden="true">{initial}</span
                  >
                  <span class="grid min-w-0 flex-1 text-start leading-tight">
                    <span class="truncate text-sm font-medium">{name}</span>
                    {#if data.user.displayName}
                      <span class="text-muted-foreground truncate text-xs"
                        >{data.user.username}</span
                      >
                    {/if}
                  </span>
                  <ChevronsUpDownIcon class="ms-auto size-4" />
                </Sidebar.MenuButton>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="top" align="start" class="min-w-56">
              <DropdownMenu.Label class="truncate">{name}</DropdownMenu.Label>
              <DropdownMenu.Separator />
              <DropdownMenu.Item>
                {#snippet child({ props })}
                  <a href={resolve("/settings/account")} {...props}>
                    <SettingsIcon />
                    Account settings
                  </a>
                {/snippet}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Group>
                <DropdownMenu.GroupHeading>Theme</DropdownMenu.GroupHeading>
                <DropdownMenu.RadioGroup
                  value={userPrefersMode.current}
                  onValueChange={(v) =>
                    setMode(v as (typeof modes)[number]["value"])}
                >
                  {#each modes as m (m.value)}
                    <DropdownMenu.RadioItem value={m.value}>
                      <m.icon />
                      {m.label}
                    </DropdownMenu.RadioItem>
                  {/each}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
              <form method="POST" action="/logout">
                <DropdownMenu.Item>
                  {#snippet child({ props })}
                    <button
                      type="submit"
                      {...props}
                      class={cn(props.class as string, "w-full")}
                    >
                      <LogOutIcon />
                      Log out
                    </button>
                  {/snippet}
                </DropdownMenu.Item>
              </form>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.Footer>
    <Sidebar.Rail />
  </Sidebar.Root>

  <Sidebar.Inset class="min-w-0">
    <header
      class="bg-background/70 sticky top-0 z-10 flex h-12 items-center gap-2 border-b px-4 backdrop-blur-md backdrop-saturate-150"
    >
      <Sidebar.Trigger />
      <span class="text-sm font-medium md:hidden">Kept</span>
    </header>
    <div class="mx-auto w-full max-w-5xl min-w-0 flex-1 p-4 md:p-8">
      {#key page.url.pathname}
        <div
          class="animate-in fade-in slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none"
        >
          {@render children()}
        </div>
      {/key}
    </div>
  </Sidebar.Inset>
</Sidebar.Provider>
