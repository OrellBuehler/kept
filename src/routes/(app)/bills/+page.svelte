<script lang="ts">
  import { resolve } from "$app/paths";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ReceiptIcon from "@lucide/svelte/icons/receipt";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Alert from "$lib/components/ui/alert";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Empty from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import BillRow from "$lib/components/bills/BillRow.svelte";
  import SuggestionCard from "$lib/components/bills/SuggestionCard.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const sections = $derived([
    {
      key: "overdue",
      title: "Overdue",
      bills: data.groups.overdue,
      tone: "text-destructive",
    },
    {
      key: "dueSoon",
      title: "Due soon",
      bills: data.groups.dueSoon,
      tone: "",
    },
    {
      key: "awaitingRefund",
      title: "Awaiting refund",
      bills: data.groups.awaitingRefund,
      tone: "",
    },
    { key: "open", title: "Open", bills: data.groups.openOther, tone: "" },
    {
      key: "recentlyPaid",
      title: "Recently paid",
      bills: data.groups.recentlyPaid,
      tone: "",
    },
  ]);

  const olderPaid = $derived(
    Math.max(0, data.counts.paid - data.groups.recentlyPaid.length),
  );
  let cancelledOpen = $state(false);
</script>

<svelte:head>
  <title>Bills · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-2xl font-semibold tracking-tight">Bills</h1>
    <Button href={resolve("/(app)/bills/new")}>
      <PlusIcon /> Add bill
    </Button>
  </div>

  {#if data.autoMatched > 0}
    <Alert.Root>
      <CircleCheckIcon />
      <Alert.Description>
        {data.autoMatched}
        {data.autoMatched === 1 ? "payment" : "payments"} matched automatically.
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if data.matchingFailed}
    <Alert.Root variant="destructive">
      <TriangleAlertIcon />
      <Alert.Description>
        Automatic matching could not run, so payment suggestions are missing.
        Reload the page to try again.
      </Alert.Description>
    </Alert.Root>
  {:else if data.suggestionsTruncated}
    <Alert.Root>
      <TriangleAlertIcon />
      <Alert.Description>
        Only the most recent transactions were checked for matches. Older
        payments can still be matched from the bill's page.
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if data.suggestions.length > 0}
    <section class="grid gap-2" aria-labelledby="suggestions-heading">
      <h2 id="suggestions-heading" class="text-sm font-medium">
        Suggestions to confirm
        <span class="text-muted-foreground font-normal">
          ({data.suggestions.length})
        </span>
      </h2>
      <ul class="divide-y rounded-lg border">
        {#each data.suggestions as suggestion (suggestion.billId + suggestion.transactionId)}
          <SuggestionCard
            {suggestion}
            confirmAction="?/confirmSuggestion"
            dismissAction="?/dismissSuggestion"
          />
        {/each}
      </ul>
    </section>
  {/if}

  {#if data.counts.total === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><ReceiptIcon /></Empty.Media>
        <Empty.Title>No bills yet</Empty.Title>
        <Empty.Description>
          Upload a QR-bill PDF or add a bill manually. Kept matches payments to
          bills for you.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href={resolve("/(app)/bills/new")}>
          <PlusIcon /> Add bill
        </Button>
        <p class="text-muted-foreground max-w-sm text-xs">
          eBill: download the invoice PDF in your e-banking and upload it here.
        </p>
      </Empty.Content>
    </Empty.Root>
  {:else}
    {#each sections as section (section.key)}
      {#if section.bills.length > 0}
        <section class="grid gap-2" aria-labelledby="{section.key}-heading">
          <h2 id="{section.key}-heading" class="text-sm font-medium">
            <span class={section.tone}>{section.title}</span>
            <span class="text-muted-foreground font-normal">
              ({section.bills.length})
            </span>
          </h2>
          <ul class="divide-y overflow-hidden rounded-lg border">
            {#each section.bills as bill (bill.id)}
              <BillRow {bill} />
            {/each}
          </ul>
        </section>
      {/if}
    {/each}

    {#if olderPaid > 0}
      <p class="text-muted-foreground text-sm">
        {olderPaid} older paid {olderPaid === 1 ? "bill is" : "bills are"} not shown.
      </p>
    {/if}

    {#if data.cancelled.length > 0}
      <Collapsible.Root bind:open={cancelledOpen} class="grid gap-2">
        <Collapsible.Trigger
          class="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm font-medium"
        >
          <ChevronDownIcon
            class={cancelledOpen ? "size-4" : "size-4 -rotate-90"}
          />
          Cancelled ({data.cancelled.length})
        </Collapsible.Trigger>
        <Collapsible.Content>
          <ul class="divide-y overflow-hidden rounded-lg border">
            {#each data.cancelled as bill (bill.id)}
              <BillRow {bill} />
            {/each}
          </ul>
        </Collapsible.Content>
      </Collapsible.Root>
    {/if}
  {/if}
</div>
