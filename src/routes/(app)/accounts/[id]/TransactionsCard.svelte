<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import * as Card from "$lib/components/ui/card";
  import * as Table from "$lib/components/ui/table";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import Amount from "$lib/components/Amount.svelte";
  import CategorySelect from "$lib/components/CategorySelect.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { FULL_SHARE_BPS, formatShare, shareOf } from "$lib/money";
  import UsersIcon from "@lucide/svelte/icons/users";
  import ArrowLeftRightIcon from "@lucide/svelte/icons/arrow-left-right";
  import FilterIcon from "@lucide/svelte/icons/filter";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import StickyNoteIcon from "@lucide/svelte/icons/sticky-note";
  import type { PageData } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  type Tx = PageData["transactions"]["items"][number];

  let {
    accountId,
    currency,
    shareBps = FULL_SHARE_BPS,
    transactions,
    categories,
    filters,
    filterErrors,
    onSelect,
    onAdd,
  }: {
    accountId: string;
    currency: string;
    /** Ownership share of the account; below 10000 amounts also show "my share". */
    shareBps?: number;
    transactions: PageData["transactions"];
    categories: PageData["categories"];
    filters: PageData["filters"];
    filterErrors: PageData["filterErrors"];
    onSelect: (tx: Tx) => void;
    onAdd: () => void;
  } = $props();

  const shared = $derived(shareBps < FULL_SHARE_BPS);

  const hasFilters = $derived(Object.values(filters).some((v) => v !== ""));
  const first = $derived(
    transactions.total === 0
      ? 0
      : (transactions.page - 1) * transactions.pageSize + 1,
  );
  const last = $derived(
    Math.min(transactions.total, transactions.page * transactions.pageSize),
  );

  function pageHref(n: number) {
    const params = new SvelteURLSearchParams(page.url.search);
    for (const key of ["imported", "linked", "mirrored", "needsAmount"])
      params.delete(key);
    if (n <= 1) params.delete("page");
    else params.set("page", String(n));
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  }

  function title(tx: Tx) {
    return tx.counterpartyName ?? tx.description ?? "No description";
  }
  function subtitle(tx: Tx) {
    return tx.counterpartyName ? tx.description : null;
  }
  function sourceLabel(tx: Tx) {
    return tx.source === "manual" ? "manual" : "imported";
  }
  function accountHref(id: string) {
    return resolve("/(app)/accounts/[id]", { id });
  }
  function activate(e: KeyboardEvent, tx: Tx) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(tx);
    }
  }
</script>

{#snippet sourceBadge(tx: Tx)}
  {#if tx.source === "mirror" && tx.mirrorOf}
    <Badge
      variant="outline"
      href={accountHref(tx.mirrorOf.accountId)}
      title="Created from a transfer in {tx.mirrorOf.accountName}"
      onclick={(e: MouseEvent) => e.stopPropagation()}
    >
      <ArrowLeftRightIcon aria-hidden="true" />
      mirrored
      <span class="sr-only">from {tx.mirrorOf.accountName}</span>
    </Badge>
  {:else}
    <Badge variant={tx.source === "manual" ? "secondary" : "outline"}>
      {sourceLabel(tx)}
    </Badge>
  {/if}
  {#if tx.mirrorOf?.noBankCounterpart}
    <Badge
      variant="outline"
      class="border-amber-500/50 text-amber-700 dark:text-amber-400"
      title="The imported statement covers this date, but none of its rows matches this mirrored transaction."
    >
      <TriangleAlertIcon aria-hidden="true" />
      no bank counterpart
    </Badge>
  {/if}
{/snippet}

{#snippet transferLink(tx: Tx)}
  {#if tx.transfer}
    <a
      href={accountHref(tx.transfer.peerAccountId)}
      class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex max-w-full items-center gap-1 rounded-sm text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-[3px]"
      onclick={(e) => e.stopPropagation()}
    >
      <ArrowLeftRightIcon class="size-3 shrink-0" aria-hidden="true" />
      <span class="truncate">
        {tx.transfer.direction === "out" ? "To" : "From"}
        {tx.transfer.peerAccountName}
      </span>
    </a>
    {#if tx.transfer.status === "needs_amount"}
      <Badge
        variant="outline"
        class="border-amber-500/50 text-amber-700 dark:text-amber-400"
      >
        needs amount
      </Badge>
    {/if}
  {/if}
{/snippet}

<Card.Root>
  <Card.Header>
    <Card.Title>Transactions</Card.Title>
    <Card.Description>
      {transactions.total}
      {transactions.total === 1 ? "transaction" : "transactions"}{hasFilters
        ? " match the filters"
        : ""}
    </Card.Description>
    <Card.Action>
      <Button size="sm" onclick={onAdd}><PlusIcon /> Add transaction</Button>
    </Card.Action>
  </Card.Header>
  <Card.Content class="grid gap-4">
    <form
      method="GET"
      class="grid grid-cols-2 items-start gap-3 lg:grid-cols-[1fr_1fr_2fr_1fr_1fr_auto]"
    >
      <FormField label="From" for="f-from" errors={filterErrors.from}>
        <Input
          id="f-from"
          name="from"
          type="date"
          value={filters.from}
          aria-invalid={!!filterErrors.from}
        />
      </FormField>
      <FormField label="To" for="f-to" errors={filterErrors.to}>
        <Input
          id="f-to"
          name="to"
          type="date"
          value={filters.to}
          aria-invalid={!!filterErrors.to}
        />
      </FormField>
      <FormField label="Search" for="f-q" class="col-span-2 lg:col-span-1">
        <Input
          id="f-q"
          name="q"
          type="search"
          placeholder="Counterparty, description, note"
          value={filters.q}
        />
      </FormField>
      <FormField label="Min amount" for="f-min" errors={filterErrors.min}>
        <Input
          id="f-min"
          name="min"
          inputmode="decimal"
          class="tabular-nums"
          placeholder="-100.00"
          value={filters.min}
          aria-invalid={!!filterErrors.min}
        />
      </FormField>
      <FormField label="Max amount" for="f-max" errors={filterErrors.max}>
        <Input
          id="f-max"
          name="max"
          inputmode="decimal"
          class="tabular-nums"
          placeholder="500.00"
          value={filters.max}
          aria-invalid={!!filterErrors.max}
        />
      </FormField>
      <div class="col-span-2 flex items-center gap-2 lg:col-span-1 lg:pt-5.5">
        <Button type="submit" variant="secondary"><FilterIcon /> Apply</Button>
        {#if hasFilters}
          <Button variant="ghost" href="?">Clear</Button>
        {/if}
      </div>
    </form>

    {#if transactions.total === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><ArrowLeftRightIcon /></Empty.Media>
          {#if hasFilters}
            <Empty.Title>No matching transactions</Empty.Title>
            <Empty.Description>
              Nothing matches these filters. Try a wider range or clear them.
            </Empty.Description>
          {:else}
            <Empty.Title>No transactions yet</Empty.Title>
            <Empty.Description>
              Import a statement, or add a transaction by hand.
            </Empty.Description>
          {/if}
        </Empty.Header>
        <Empty.Content>
          <div class="flex flex-wrap justify-center gap-2">
            {#if hasFilters}
              <Button variant="outline" href="?">Clear filters</Button>
            {:else}
              <Button href="{resolve('/(app)/import')}?account={accountId}">
                <UploadIcon /> Import statement
              </Button>
              <Button variant="outline" onclick={onAdd}>
                <PlusIcon /> Add transaction
              </Button>
            {/if}
          </div>
        </Empty.Content>
      </Empty.Root>
    {:else}
      <div class="hidden sm:block">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head class="w-32">Date</Table.Head>
              <Table.Head>Description</Table.Head>
              <Table.Head class="w-48">Category</Table.Head>
              <Table.Head class="w-36">Source</Table.Head>
              <Table.Head class="w-40 text-end">Amount</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each transactions.items as tx (tx.id)}
              <Table.Row class="cursor-pointer" onclick={() => onSelect(tx)}>
                <Table.Cell class="align-top whitespace-nowrap">
                  <button
                    type="button"
                    class="focus-visible:ring-ring/50 rounded-sm text-start outline-none focus-visible:ring-[3px]"
                    onkeydown={(e) => activate(e, tx)}
                    onclick={(e) => {
                      e.stopPropagation();
                      onSelect(tx);
                    }}
                  >
                    {prefs.date(tx.bookingDate)}
                  </button>
                </Table.Cell>
                <Table.Cell class="max-w-0 align-top whitespace-normal">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-medium">{title(tx)}</span>
                    {#if tx.note}
                      <StickyNoteIcon
                        class="text-muted-foreground size-3.5 shrink-0"
                        aria-label="Has a note"
                      />
                    {/if}
                  </div>
                  {#if subtitle(tx)}
                    <div class="text-muted-foreground truncate text-xs">
                      {subtitle(tx)}
                    </div>
                  {/if}
                  {#if tx.reference}
                    <div
                      class="text-muted-foreground truncate font-mono text-xs"
                    >
                      {tx.reference}
                    </div>
                  {/if}
                  {#if tx.transfer}
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                      {@render transferLink(tx)}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="align-top">
                  <CategorySelect
                    transactionId={tx.id}
                    categoryId={tx.categoryId}
                    {categories}
                  />
                </Table.Cell>
                <Table.Cell class="align-top">
                  <div class="flex flex-col items-start gap-1">
                    {@render sourceBadge(tx)}
                  </div>
                </Table.Cell>
                <Table.Cell class="text-end align-top">
                  <Amount value={tx.amount} {currency} flow />
                  {#if shared}
                    <div
                      class="text-muted-foreground flex items-center justify-end gap-1 text-xs"
                      title="Shared account, your share {formatShare(shareBps)}"
                    >
                      <UsersIcon class="size-3" aria-hidden="true" />
                      <span class="sr-only">My share</span>
                      <Amount
                        value={shareOf(tx.amount, shareBps)}
                        {currency}
                        flow
                      />
                    </div>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>

      <ul class="divide-y rounded-md border sm:hidden">
        {#each transactions.items as tx (tx.id)}
          <li>
            <button
              type="button"
              class="hover:bg-muted/50 focus-visible:ring-ring/50 grid w-full gap-1 p-3 text-start outline-none focus-visible:ring-[3px]"
              onclick={() => onSelect(tx)}
            >
              <span class="flex items-start justify-between gap-3">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-medium">{title(tx)}</span>
                  {#if tx.note}
                    <StickyNoteIcon
                      class="text-muted-foreground size-3.5 shrink-0"
                      aria-label="Has a note"
                    />
                  {/if}
                </span>
                <span class="shrink-0 text-end">
                  <Amount
                    value={tx.amount}
                    {currency}
                    flow
                    class="font-medium"
                  />
                  {#if shared}
                    <span
                      class="text-muted-foreground flex items-center justify-end gap-1 text-xs"
                    >
                      <UsersIcon class="size-3" aria-hidden="true" />
                      <span class="sr-only">My share</span>
                      <Amount
                        value={shareOf(tx.amount, shareBps)}
                        {currency}
                        flow
                      />
                    </span>
                  {/if}
                </span>
              </span>
              {#if subtitle(tx)}
                <span class="text-muted-foreground truncate text-xs">
                  {subtitle(tx)}
                </span>
              {/if}
              <span
                class="text-muted-foreground flex items-center justify-between gap-2 text-xs"
              >
                <span>{prefs.date(tx.bookingDate)}</span>
                <span class="flex min-w-0 items-center gap-2">
                  {#if tx.reference}
                    <span class="truncate font-mono">{tx.reference}</span>
                  {/if}
                </span>
              </span>
            </button>
            <div class="grid gap-2 px-3 pb-3">
              <div class="flex flex-wrap items-center gap-1.5">
                {@render sourceBadge(tx)}
                {@render transferLink(tx)}
              </div>
              <CategorySelect
                transactionId={tx.id}
                categoryId={tx.categoryId}
                {categories}
              />
            </div>
          </li>
        {/each}
      </ul>

      <nav
        class="flex flex-wrap items-center justify-between gap-2"
        aria-label="Pagination"
      >
        <p class="text-muted-foreground text-sm tabular-nums">
          {first}–{last} of {transactions.total}
        </p>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            href={pageHref(transactions.page - 1)}
            disabled={transactions.page <= 1}
          >
            Previous
          </Button>
          <span class="text-muted-foreground text-sm tabular-nums">
            Page {transactions.page} of {transactions.pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            href={pageHref(transactions.page + 1)}
            disabled={transactions.page >= transactions.pageCount}
          >
            Next
          </Button>
        </div>
      </nav>
    {/if}
  </Card.Content>
</Card.Root>
