<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { resolve } from "$app/paths";
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ReceiptIcon from "@lucide/svelte/icons/receipt";
  import SearchIcon from "@lucide/svelte/icons/search";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Alert from "$lib/components/ui/alert";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import * as Empty from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import BillRow from "$lib/components/bills/BillRow.svelte";
  import SuggestionCard from "$lib/components/bills/SuggestionCard.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let matching = $state(false);
  let matchErrors = $state<NonNullable<FormErrors>>({});

  const statusOptions = [
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "overdue", label: "Overdue" },
    { value: "paid", label: "Paid" },
    { value: "refund", label: "Awaiting refund" },
    { value: "cancelled", label: "Cancelled" },
  ];

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
  ]);

  const filtered = $derived(data.query.q !== "" || data.query.status !== "all");
  const first = $derived(
    data.list.total === 0 ? 0 : (data.list.page - 1) * data.list.pageSize + 1,
  );
  const last = $derived(
    Math.min(data.list.total, data.list.page * data.list.pageSize),
  );

  function pageHref(n: number) {
    const params = new SvelteURLSearchParams(page.url.searchParams);
    if (n <= 1) params.delete("page");
    else params.set("page", String(n));
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  }
</script>

<svelte:head>
  <title>Bills · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <PageHeader title="Bills">
    {#snippet actions()}
      <Button href={resolve("/(app)/bills/new")}>
        <PlusIcon /> Add bill
      </Button>
    {/snippet}
  </PageHeader>

  {#if data.autoMatchPending > 0}
    <Alert.Root>
      <CircleCheckIcon />
      <Alert.Description class="flex flex-wrap items-center gap-3">
        <span>
          {data.autoMatchPending}
          {data.autoMatchPending === 1 ? "payment" : "payments"} match a bill's reference
          exactly.
        </span>
        <form
          method="POST"
          action="?/matchNow"
          use:enhance={submitHandler({
            setPending: (v) => (matching = v),
            setErrors: (e) => (matchErrors = e),
            onSuccessData: (d) => {
              const n = typeof d?.matched === "number" ? d.matched : 0;
              toast.success(
                `${n} ${n === 1 ? "payment" : "payments"} matched.`,
              );
            },
          })}
        >
          <Button type="submit" size="sm" disabled={matching}>
            {#if matching}<Spinner />{/if}
            Match now
          </Button>
        </form>
      </Alert.Description>
    </Alert.Root>
    {#each Object.values(matchErrors).flat() as message (message)}
      <p class="text-destructive text-sm" role="alert">{message}</p>
    {/each}
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
    {#if !filtered && data.list.page === 1}
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
    {/if}

    <section class="grid gap-3" aria-labelledby="all-heading">
      <h2 id="all-heading" class="text-sm font-medium">
        All bills
        <span class="text-muted-foreground font-normal tabular-nums">
          ({data.list.total})
        </span>
      </h2>

      <form method="GET" class="flex flex-wrap items-center gap-2">
        <Input
          name="q"
          type="search"
          aria-label="Search bills"
          placeholder="Search creditor, number, reference, amount"
          value={data.query.q}
          class="min-w-0 flex-1 basis-full sm:basis-64"
        />
        <NativeSelect.Root
          name="status"
          aria-label="Status"
          value={data.query.status}
          onchange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {#each statusOptions as option (option.value)}
            <NativeSelect.Option value={option.value}>
              {option.label}
            </NativeSelect.Option>
          {/each}
        </NativeSelect.Root>
        <Button type="submit" variant="secondary"><SearchIcon /> Search</Button>
        {#if filtered}
          <Button variant="ghost" href={resolve("/(app)/bills")}>Clear</Button>
        {/if}
      </form>

      {#if data.list.total === 0}
        <Empty.Root class="border border-dashed">
          <Empty.Header>
            <Empty.Media variant="icon"><ReceiptIcon /></Empty.Media>
            <Empty.Title>No bills match</Empty.Title>
            <Empty.Description>
              No bills match these filters. Try different words or clear the
              filter.
            </Empty.Description>
          </Empty.Header>
          {#if filtered}
            <Empty.Content>
              <Button variant="outline" href={resolve("/(app)/bills")}>
                Clear filter
              </Button>
            </Empty.Content>
          {/if}
        </Empty.Root>
      {:else}
        <ul class="divide-y overflow-hidden rounded-lg border">
          {#each data.list.items as bill (bill.id)}
            <BillRow {bill} />
          {/each}
        </ul>

        {#if data.list.pageCount > 1}
          <nav
            class="flex flex-wrap items-center justify-between gap-2"
            aria-label="Pagination"
          >
            <p class="text-muted-foreground text-sm tabular-nums">
              {first}–{last} of {data.list.total}
            </p>
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                href={pageHref(data.list.page - 1)}
                disabled={data.list.page <= 1}
              >
                Previous
              </Button>
              <span class="text-muted-foreground text-sm tabular-nums">
                Page {data.list.page} of {data.list.pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                href={pageHref(data.list.page + 1)}
                disabled={data.list.page >= data.list.pageCount}
              >
                Next
              </Button>
            </div>
          </nav>
        {/if}
      {/if}
    </section>
  {/if}
</div>
