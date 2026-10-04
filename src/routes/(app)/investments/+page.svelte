<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import {
    PRICE_SOURCE_LABELS,
    SECURITY_KIND_LABELS,
  } from "$lib/investment-labels";
  import { formatFixed } from "$lib/quantity";
  import { usePreferences } from "$lib/preferences.svelte";
  import ChartLineIcon from "@lucide/svelte/icons/chart-line";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import PriceHistorySheet from "./PriceHistorySheet.svelte";
  import SecurityFormDialog from "./SecurityFormDialog.svelte";
  import type { PageData, PageProps } from "./$types";

  type Security = PageData["securities"][number];

  const prefs = usePreferences();

  let { data }: PageProps = $props();

  let formOpen = $state(false);
  let editing = $state<Security | null>(null);
  let deleting = $state<Security | null>(null);
  let deleteOpen = $state(false);
  // Kept after the sheet closes so its content does not vanish mid-animation.
  let shownHistory = $state<PageData["priceHistory"]>(null);

  $effect(() => {
    if (data.priceHistory) shownHistory = data.priceHistory;
  });

  function openForm(security: Security | null) {
    editing = security;
    formOpen = true;
  }

  function closeSheet() {
    void goto(resolve("/(app)/investments"), {
      keepFocus: true,
      noScroll: true,
    });
  }

  const qty = (v: Parameters<typeof formatFixed>[0]) =>
    formatFixed(v, prefs.locale);
  const unit = (v: Parameters<typeof formatFixed>[0]) =>
    formatFixed(v, prefs.locale, 2);
</script>

<svelte:head>
  <title>Investments · Kept</title>
</svelte:head>

<div class="grid grid-cols-[minmax(0,1fr)] gap-6">
  <PageHeader
    title="Investments"
    description="Your securities and what you hold in them, across all accounts."
  >
    {#snippet actions()}
      <Button onclick={() => openForm(null)}>
        <PlusIcon /> Add security
      </Button>
    {/snippet}
  </PageHeader>

  {#if data.securities.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><ChartLineIcon /></Empty.Media>
        <Empty.Title>No securities yet</Empty.Title>
        <Empty.Description>
          Add the ETFs, stocks and funds you hold, then record your trades on
          the investment account's page.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button onclick={() => openForm(null)}>
          <PlusIcon /> Add security
        </Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    {#if data.overview.totals.length > 0}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {#each data.overview.totals as t (t.currency)}
          <Card.Root>
            <Card.Header>
              <Card.Description class="flex items-center gap-2">
                Holdings in {t.currency}
                {#if t.estimated}
                  <Badge
                    variant="outline"
                    title="Some positions are valued at cost because an exchange rate is missing."
                  >
                    estimated
                  </Badge>
                {/if}
              </Card.Description>
              <Card.Title class="text-2xl">
                <Amount value={t.value} currency={t.currency} />
              </Card.Title>
            </Card.Header>
            <Card.Content class="grid gap-1 text-sm">
              <div class="flex justify-between gap-4">
                <span class="text-muted-foreground">Cost</span>
                <Amount value={t.cost} currency={t.currency} />
              </div>
              <div class="flex justify-between gap-4">
                <span class="text-muted-foreground">Gain</span>
                <Amount value={t.gain} currency={t.currency} flow />
              </div>
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    {/if}

    <Card.Root>
      <Card.Header>
        <Card.Title>Positions</Card.Title>
        <Card.Description>
          Grouped by security. Values are in each account's currency.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if data.overview.securities.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><ChartLineIcon /></Empty.Media>
              <Empty.Title>No holdings</Empty.Title>
              <Empty.Description>
                Add a trade on an investment account to see your positions here.
              </Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button size="sm" href={resolve("/(app)/accounts")}>
                Go to accounts
              </Button>
            </Empty.Content>
          </Empty.Root>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Security</Table.Head>
                <Table.Head class="hidden text-end sm:table-cell">
                  Quantity
                </Table.Head>
                <Table.Head class="hidden text-end md:table-cell">
                  Last price
                </Table.Head>
                <Table.Head class="text-end">Value</Table.Head>
                <Table.Head class="text-end">Gain</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each data.overview.securities as g (g.securityId)}
                <Table.Row>
                  <Table.Cell class="max-w-48 whitespace-normal">
                    <span class="font-medium break-words">{g.name}</span>
                    <div class="text-muted-foreground text-xs sm:hidden">
                      {qty(g.quantity)} × {unit(g.price)}
                      {g.currency}
                    </div>
                  </Table.Cell>
                  <Table.Cell
                    class="hidden text-end tabular-nums sm:table-cell"
                  >
                    {qty(g.quantity)}
                  </Table.Cell>
                  <Table.Cell
                    class="hidden text-end tabular-nums md:table-cell"
                  >
                    <div class="whitespace-nowrap">
                      {unit(g.price)}
                      {g.currency}
                    </div>
                    <div class="text-muted-foreground text-xs">
                      {prefs.date(g.priceDate)} · {PRICE_SOURCE_LABELS[
                        g.priceSource
                      ]}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="text-end">
                    {#each g.totals as t (t.currency)}
                      <div>
                        <Amount value={t.value} currency={t.currency} />
                      </div>
                    {/each}
                  </Table.Cell>
                  <Table.Cell class="text-end">
                    {#each g.totals as t (t.currency)}
                      <div>
                        {#if t.estimated}
                          <span class="text-muted-foreground">–</span>
                        {:else}
                          <Amount value={t.gain} currency={t.currency} flow />
                        {/if}
                      </div>
                    {/each}
                  </Table.Cell>
                </Table.Row>
                {#if g.positions.length > 1}
                  {#each g.positions as p (p.accountId)}
                    <Table.Row class="text-muted-foreground text-xs">
                      <Table.Cell class="max-w-48 ps-6 whitespace-normal">
                        <a
                          href={resolve("/(app)/accounts/[id]", {
                            id: p.accountId,
                          })}
                          class="hover:text-foreground break-words underline-offset-2 hover:underline"
                        >
                          {p.accountName}
                        </a>
                        {#if p.institutionName}
                          <span class="break-words">
                            · {p.institutionName}
                          </span>
                        {/if}
                      </Table.Cell>
                      <Table.Cell
                        class="hidden text-end tabular-nums sm:table-cell"
                      >
                        {qty(p.quantity)}
                      </Table.Cell>
                      <Table.Cell class="hidden md:table-cell"></Table.Cell>
                      <Table.Cell class="text-end">
                        <Amount value={p.value} currency={p.accountCurrency} />
                      </Table.Cell>
                      <Table.Cell class="text-end">
                        {#if p.estimated}
                          –
                        {:else}
                          <Amount
                            value={p.gain}
                            currency={p.accountCurrency}
                            flow
                          />
                        {/if}
                      </Table.Cell>
                    </Table.Row>
                  {/each}
                {/if}
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Securities</Card.Title>
        <Card.Description>
          Prices come from the market data provider or from you. Set a price by
          hand where there is no symbol.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Name</Table.Head>
              <Table.Head class="hidden sm:table-cell">Type</Table.Head>
              <Table.Head class="hidden md:table-cell">Symbol</Table.Head>
              <Table.Head class="hidden sm:table-cell">Currency</Table.Head>
              <Table.Head class="w-28">
                <span class="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.securities as s (s.id)}
              <Table.Row>
                <Table.Cell class="max-w-48 whitespace-normal">
                  <span class="font-medium break-words">{s.name}</span>
                  {#if s.isin}
                    <div class="text-muted-foreground font-mono text-xs">
                      {s.isin}
                    </div>
                  {/if}
                  <div
                    class="text-muted-foreground font-mono text-xs sm:hidden"
                  >
                    {s.currency}
                  </div>
                </Table.Cell>
                <Table.Cell class="hidden sm:table-cell">
                  <Badge variant="outline">
                    {SECURITY_KIND_LABELS[s.kind]}
                  </Badge>
                </Table.Cell>
                <Table.Cell class="hidden font-mono text-xs md:table-cell">
                  {s.symbol ?? "–"}
                </Table.Cell>
                <Table.Cell class="hidden font-mono text-xs sm:table-cell">
                  {s.currency}
                </Table.Cell>
                <Table.Cell class="text-end whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    href="{resolve('/(app)/investments')}?prices={s.id}"
                    aria-label="Prices of {s.name}"
                  >
                    <ChartLineIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Edit {s.name}"
                    onclick={() => openForm(s)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete {s.name}"
                    onclick={() => {
                      deleting = s;
                      deleteOpen = true;
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>
  {/if}
</div>

<SecurityFormDialog
  bind:open={formOpen}
  security={editing}
  canLookup={data.marketData.canLookup}
  lookupEnabled={data.marketData.enabled}
/>

<PriceHistorySheet
  bind:open={
    () => data.priceHistory !== null,
    (v) => {
      if (!v) closeSheet();
    }
  }
  history={shownHistory}
/>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete {deleting?.name ?? 'this security'}?"
  description="The security and its price history are removed. This is not possible while it has trades."
  action="?/deleteSecurity"
  fields={{ securityId: deleting?.id ?? "" }}
  successMessage="Security deleted"
/>
