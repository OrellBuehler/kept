<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import * as Table from "$lib/components/ui/table";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import { PRICE_SOURCE_LABELS } from "$lib/investment-labels";
  import { formatFixed } from "$lib/quantity";
  import ChartLineIcon from "@lucide/svelte/icons/chart-line";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TradeFormDialog from "./TradeFormDialog.svelte";
  import type { PageData } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  type Trade = PageData["trades"][number];

  let {
    positions,
    trades,
    securities,
    currency,
  }: {
    positions: NonNullable<PageData["value"]>["positions"];
    trades: Trade[];
    securities: PageData["securities"];
    currency: string;
  } = $props();

  let formOpen = $state(false);
  let editing = $state<Trade | null>(null);
  let deleting = $state<Trade | null>(null);
  let deleteOpen = $state(false);

  function askAdd() {
    editing = null;
    formOpen = true;
  }

  function askEdit(t: Trade) {
    editing = t;
    formOpen = true;
  }

  function askDelete(t: Trade) {
    deleting = t;
    deleteOpen = true;
  }

  const qty = (v: Parameters<typeof formatFixed>[0]) =>
    formatFixed(v, prefs.locale);
  const unit = (v: Parameters<typeof formatFixed>[0]) =>
    formatFixed(v, prefs.locale, 2);
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Holdings</Card.Title>
    <Card.Description>
      What you hold, valued at the latest price. The account total is the cash
      balance plus these holdings.
    </Card.Description>
    <Card.Action>
      <Button size="sm" variant="outline" onclick={askAdd}>
        <PlusIcon /> Add trade
      </Button>
    </Card.Action>
  </Card.Header>
  <Card.Content>
    <Tabs.Root value="positions">
      <Tabs.List>
        <Tabs.Trigger value="positions">Positions</Tabs.Trigger>
        <Tabs.Trigger value="trades">Trades</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="positions" class="pt-4">
        {#if positions.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><ChartLineIcon /></Empty.Media>
              <Empty.Title>No holdings</Empty.Title>
              <Empty.Description>
                Record your buys and sells to see what this account holds and
                what it is worth.
              </Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button size="sm" onclick={askAdd}>
                <PlusIcon /> Add trade
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
                <Table.Head class="hidden text-end md:table-cell">
                  Cost
                </Table.Head>
                <Table.Head class="text-end">Gain</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each positions as p (p.securityId)}
                <Table.Row>
                  <Table.Cell class="max-w-48 whitespace-normal">
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span class="font-medium break-words">{p.name}</span>
                      {#if p.estimated}
                        <Badge
                          variant="outline"
                          title="No exchange rate is known for {p.currency}, so this position is valued at cost."
                        >
                          estimated
                        </Badge>
                      {/if}
                    </div>
                    <div class="text-muted-foreground text-xs sm:hidden">
                      {qty(p.quantity)} × {unit(p.price)}
                      {p.currency}
                    </div>
                  </Table.Cell>
                  <Table.Cell
                    class="hidden text-end tabular-nums sm:table-cell"
                  >
                    {qty(p.quantity)}
                  </Table.Cell>
                  <Table.Cell
                    class="hidden text-end tabular-nums md:table-cell"
                  >
                    <div class="whitespace-nowrap">
                      {unit(p.price)}
                      {p.currency}
                    </div>
                    <div class="text-muted-foreground text-xs">
                      {prefs.date(p.priceDate)} · {PRICE_SOURCE_LABELS[
                        p.priceSource
                      ]}
                    </div>
                  </Table.Cell>
                  <Table.Cell class="text-end">
                    <Amount value={p.value} {currency} />
                  </Table.Cell>
                  <Table.Cell class="hidden text-end md:table-cell">
                    <Amount value={p.cost} {currency} />
                  </Table.Cell>
                  <Table.Cell class="text-end">
                    {#if p.estimated}
                      <span class="text-muted-foreground">–</span>
                    {:else}
                      <Amount value={p.gain} {currency} flow />
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="trades" class="pt-4">
        {#if trades.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><ChartLineIcon /></Empty.Media>
              <Empty.Title>No trades</Empty.Title>
              <Empty.Description>
                Trades do not create cash transactions. Your imported statements
                already contain the cash side.
              </Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button size="sm" onclick={askAdd}>
                <PlusIcon /> Add trade
              </Button>
            </Empty.Content>
          </Empty.Root>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head class="hidden sm:table-cell">Date</Table.Head>
                <Table.Head>Security</Table.Head>
                <Table.Head class="hidden text-end sm:table-cell">
                  Quantity
                </Table.Head>
                <Table.Head class="hidden text-end md:table-cell">
                  Price
                </Table.Head>
                <Table.Head class="text-end">Amount</Table.Head>
                <Table.Head class="w-20">
                  <span class="sr-only">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each trades as t (t.id)}
                <Table.Row>
                  <Table.Cell class="hidden whitespace-nowrap sm:table-cell">
                    {prefs.date(t.date)}
                  </Table.Cell>
                  <Table.Cell class="whitespace-normal sm:max-w-44">
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge
                        variant={t.side === "buy" ? "secondary" : "outline"}
                      >
                        {t.side === "buy" ? "Buy" : "Sell"}
                      </Badge>
                      <span class="break-words">{t.securityName}</span>
                    </div>
                    <div class="text-muted-foreground text-xs sm:hidden">
                      {prefs.date(t.date)} · {qty(t.quantity)} × {unit(t.price)}
                      {t.securityCurrency}
                    </div>
                  </Table.Cell>
                  <Table.Cell
                    class="hidden text-end tabular-nums sm:table-cell"
                  >
                    {qty(t.quantity)}
                  </Table.Cell>
                  <Table.Cell
                    class="hidden text-end whitespace-nowrap tabular-nums md:table-cell"
                  >
                    {unit(t.price)}
                    {t.securityCurrency}
                  </Table.Cell>
                  <Table.Cell class="text-end">
                    <Amount value={t.amount} {currency} />
                    {#if t.fees > 0}
                      <div class="text-muted-foreground text-xs">
                        incl. <Amount value={t.fees} {currency} /> fees
                      </div>
                    {/if}
                  </Table.Cell>
                  <Table.Cell class="text-end whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit trade from {prefs.date(t.date)}"
                      onclick={() => askEdit(t)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete trade from {prefs.date(t.date)}"
                      onclick={() => askDelete(t)}
                    >
                      <Trash2Icon />
                    </Button>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  </Card.Content>
</Card.Root>

<TradeFormDialog
  bind:open={formOpen}
  action={editing ? "?/updateTrade" : "?/addTrade"}
  {currency}
  {securities}
  trade={editing}
/>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete this trade?"
  description="The {deleting?.side === 'sell'
    ? 'sale'
    : 'purchase'} of {deleting
    ? qty(deleting.quantity)
    : ''} × {deleting?.securityName ?? ''} on {deleting
    ? prefs.date(deleting.date)
    : ''} will be removed and the holdings recalculated. Your transactions are not affected."
  action="?/deleteTrade"
  fields={{ tradeId: deleting?.id ?? "" }}
  successMessage="Trade deleted"
/>
