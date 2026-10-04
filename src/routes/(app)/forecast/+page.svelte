<script lang="ts">
  import { resolve } from "$app/paths";
  import { cn } from "$lib/utils";
  import * as Card from "$lib/components/ui/card";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Amount from "$lib/components/Amount.svelte";
  import { usePreferences } from "$lib/preferences.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import NetWorthChart from "$lib/components/dashboard/NetWorthChart.svelte";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TrendingUpIcon from "@lucide/svelte/icons/trending-up";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import type { PageData, PageProps } from "./$types";
  import AccountSettingsDialog from "./AccountSettingsDialog.svelte";
  import PlannedItemDialog from "./PlannedItemDialog.svelte";

  type Planned = PageData["planned"][number];

  const prefs = usePreferences();

  let { data }: PageProps = $props();
  const f = $derived(data.forecast);

  const chartColors = [
    "var(--color-chart-1)",
    "var(--color-chart-2)",
    "var(--color-chart-3)",
    "var(--color-chart-4)",
  ];

  const accountNames = $derived(
    new Map(f.accounts.map((a) => [a.accountId, a.name])),
  );
  const accountOptions = $derived(
    f.accounts.map((a) => ({
      id: a.accountId,
      name: a.name,
      currency: a.currency,
    })),
  );
  const currencies = $derived(
    [...new Set(f.accounts.map((a) => a.currency))].sort(),
  );
  const warnings = $derived(f.accounts.filter((a) => a.warning !== null));
  const unprojected = $derived(
    f.unprojectedBills.noDueDate + f.unprojectedBills.noAmount,
  );

  let plannedOpen = $state(false);
  let editing = $state<Planned | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<Planned | null>(null);
  let settingsOpen = $state(false);
  let settingsAccountId = $state<string | null>(null);

  const settingsAccount = $derived(
    accountOptions.find((a) => a.id === settingsAccountId) ?? null,
  );
  const settingsFor = $derived(
    data.settings.find((s) => s.accountId === settingsAccountId),
  );

  function openPlanned(item: Planned | null) {
    editing = item;
    plannedOpen = true;
  }

  function openSettings(accountId: string) {
    settingsAccountId = accountId;
    settingsOpen = true;
  }

  const SOURCE_LABELS: Record<string, string> = {
    bill: "Bill",
    planned: "Planned",
  };
</script>

<svelte:head>
  <title>Forecast · Kept</title>
</svelte:head>

<PageHeader
  title="Forecast"
  description={`Expected balances until ${prefs.date(f.to)}, per account and currency.`}
  class="mb-6"
>
  {#snippet actions()}
    <nav
      class="bg-muted inline-flex rounded-lg p-0.5"
      aria-label="Forecast horizon"
    >
      {#each data.horizons as h (h)}
        <a
          href="{resolve('/(app)/forecast')}?days={h}"
          data-sveltekit-noscroll
          aria-current={data.days === h ? "page" : undefined}
          class={cn(
            "focus-visible:ring-ring/50 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
            data.days === h
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}>{h} days</a
        >
      {/each}
    </nav>
    <Button size="sm" onclick={() => openPlanned(null)}>
      <PlusIcon /> Add planned item
    </Button>
  {/snippet}
</PageHeader>

{#if f.accounts.length === 0}
  <Empty.Root class="border border-dashed">
    <Empty.Header>
      <Empty.Media variant="icon"><TrendingUpIcon /></Empty.Media>
      <Empty.Title>No accounts to forecast</Empty.Title>
      <Empty.Description>
        Add an account and its bills, then the forecast shows how your balance
        develops.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <Button href={resolve("/accounts")}>Go to accounts</Button>
    </Empty.Content>
  </Empty.Root>
{:else}
  <div class="grid gap-4">
    {#if warnings.length > 0}
      <Card.Root class="border-destructive/50">
        <Card.Header>
          <Card.Title class="text-destructive flex items-center gap-2">
            <TriangleAlertIcon class="size-4" aria-hidden="true" />
            Low balance ahead
          </Card.Title>
        </Card.Header>
        <Card.Content>
          <ul class="space-y-1.5 text-sm">
            {#each warnings as a (a.accountId)}
              {@const w = a.warning!}
              <li>
                <span class="font-medium">{a.name}</span>
                {w.negative ? "goes below zero" : "falls below its limit of"}
                {#if !w.negative}
                  <Amount value={w.limit} currency={a.currency} />
                {/if}
                on {prefs.date(w.date)}, to
                <Amount value={w.balance} currency={a.currency} />.
              </li>
            {/each}
          </ul>
        </Card.Content>
      </Card.Root>
    {/if}

    {#each f.accounts as a, i (a.accountId)}
      <Card.Root>
        <Card.Header>
          <Card.Title>{a.name}</Card.Title>
          <Card.Description>
            {#if a.hasBalance}
              <Amount value={a.startBalance} currency={a.currency} /> now,
              <Amount value={a.endBalance} currency={a.currency} /> on
              {prefs.date(f.to)}, lowest
              <Amount value={a.lowest.balance} currency={a.currency} /> on
              {prefs.date(a.lowest.date)}
            {:else}
              No balance data yet. The chart shows the change from zero.
            {/if}
          </Card.Description>
          <Card.Action>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Forecast settings for {a.name}"
              onclick={() => openSettings(a.accountId)}
            >
              <SettingsIcon />
            </Button>
          </Card.Action>
        </Card.Header>
        <Card.Content>
          <NetWorthChart
            currency={a.currency}
            points={a.points.map((p) => ({
              date: p.date,
              amount: p.balance,
            }))}
            range="3m"
            label="Balance"
            color={chartColors[i % chartColors.length]}
          />
        </Card.Content>
      </Card.Root>
    {/each}

    {#if f.unassigned.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>Not assigned to an account</Card.Title>
          <Card.Description>
            These items are not in any chart. Set a paying account on the bill
            or a default payment account in the account settings.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <ul class="space-y-1 text-sm">
            {#each f.unassigned as u (u.currency)}
              <li>
                {u.currency}: {u.count}
                {u.count === 1 ? "item" : "items"},
                <Amount value={u.outflow} currency={u.currency} /> out,
                <Amount value={u.inflow} currency={u.currency} flow /> in
              </li>
            {/each}
          </ul>
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root>
      <Card.Header>
        <Card.Title>Upcoming items</Card.Title>
        <Card.Description>
          Open bills and planned items in the next {data.days} days. Overdue bills
          count on today.
          {#if unprojected > 0}
            {unprojected}
            {unprojected === 1 ? "unpaid bill is" : "unpaid bills are"} left out because
            {unprojected === 1 ? "it has" : "they have"} no due date or no amount.
          {/if}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if f.items.length === 0}
          <p class="text-muted-foreground text-sm">
            Nothing expected in this period.
          </p>
        {:else}
          <ul class="divide-y">
            {#each f.items as item, i (`${item.source}-${item.ref ?? i}-${i}`)}
              <li class="flex items-center justify-between gap-3 py-2 text-sm">
                <div class="min-w-0">
                  <p class="truncate font-medium">{item.label}</p>
                  <p class="text-muted-foreground text-xs">
                    {prefs.date(item.date)} ·
                    {item.accountId
                      ? (accountNames.get(item.accountId) ?? "Account")
                      : "No account"}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Badge variant="outline">
                    {SOURCE_LABELS[item.source] ?? item.source}
                  </Badge>
                  <Amount value={item.amount} currency={item.currency} flow />
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Planned items</Card.Title>
        <Card.Description>
          One-off income and expenses you add yourself.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if data.planned.length === 0}
          <p class="text-muted-foreground text-sm">
            None yet. Add a salary or a tax installment to see its effect.
          </p>
        {:else}
          <ul class="divide-y">
            {#each data.planned as p (p.id)}
              <li class="flex items-center justify-between gap-3 py-2 text-sm">
                <div class="min-w-0">
                  <p class="truncate font-medium">{p.label}</p>
                  <p class="text-muted-foreground text-xs">
                    {prefs.date(p.date)} ·
                    {p.accountId
                      ? (accountNames.get(p.accountId) ?? "Account")
                      : "No account"}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Amount value={p.amount} currency={p.currency} flow />
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      {#snippet child({ props })}
                        <Button
                          {...props}
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Actions for {p.label}"
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      {/snippet}
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content align="end">
                      <DropdownMenu.Item onSelect={() => openPlanned(p)}>
                        <PencilIcon /> Edit
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        variant="destructive"
                        onSelect={() => {
                          deleting = p;
                          deleteOpen = true;
                        }}
                      >
                        <Trash2Icon /> Delete
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
{/if}

<PlannedItemDialog
  bind:open={plannedOpen}
  item={editing}
  today={data.today}
  accounts={accountOptions}
  {currencies}
/>

<AccountSettingsDialog
  bind:open={settingsOpen}
  account={settingsAccount}
  threshold={settingsFor?.threshold ?? null}
  defaultPayment={settingsFor?.defaultPayment ?? false}
/>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete {deleting?.label ?? 'this planned item'}?"
  description="Your accounts and bills are not affected."
  action="?/deletePlanned"
  fields={{ id: deleting?.id ?? "" }}
  successMessage="Planned item deleted"
/>
