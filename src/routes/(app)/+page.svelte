<script lang="ts">
  import { resolve } from "$app/paths";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import * as Empty from "$lib/components/ui/empty/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
</script>

<svelte:head>
  <title>Dashboard · Kept</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">Dashboard</h1>

<Empty.Root class="border border-dashed">
  <Empty.Header>
    <Empty.Media variant="icon"><LayoutDashboardIcon /></Empty.Media>
    <Empty.Title>Nothing to show yet</Empty.Title>
    <Empty.Description>
      Your dashboard will appear here once you add accounts.
    </Empty.Description>
  </Empty.Header>
  <Empty.Content>
    <Button href={resolve("/accounts")}>Go to accounts</Button>
  </Empty.Content>
</Empty.Root>
