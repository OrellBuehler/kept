<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import InfoIcon from "@lucide/svelte/icons/info";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Spinner } from "$lib/components/ui/spinner";
  import * as Table from "$lib/components/ui/table";
  import Amount from "$lib/components/Amount.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import ImportSteps from "$lib/components/import/ImportSteps.svelte";
  import LocalTime from "$lib/components/import/LocalTime.svelte";

  import { formError } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { FORMAT_LABELS, formatPeriod, plural } from "$lib/import-ui";
  import { cn } from "$lib/utils";
  import type { PageProps } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let { data }: PageProps = $props();

  const warningCount = $derived(
    data.warnings.length + data.balanceWarnings.length,
  );

  let confirming = $state(false);
  let cancelling = $state(false);
  let confirmErrors = $state<Record<string, string[]>>({});
  let cancelErrors = $state<Record<string, string[]>>({});

  const busy = $derived(confirming || cancelling);
  const isTabular = $derived(data.format === "csv" || data.format === "xlsx");
  const mappingHref = $derived(
    resolve("/(app)/import/[pendingId]/mapping", {
      pendingId: data.pendingId,
    }),
  );
  const nothingNew = $derived(data.counts.new === 0);
  const otherErrors = $derived(
    data.errors.filter((e) => e !== "mapping_required"),
  );
  const firstRow = $derived((data.page - 1) * data.pageSize + 1);
  const lastRow = $derived(
    Math.min(data.page * data.pageSize, data.filteredTotal),
  );

  function query(filter: string, pageNumber: number) {
    const parts: string[] = [];
    if (filter !== "all") parts.push(`filter=${filter}`);
    if (pageNumber > 1) parts.push(`page=${pageNumber}`);
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  function pageHref(filter: string, pageNumber: number) {
    return (
      resolve("/(app)/import/[pendingId]", { pendingId: data.pendingId }) +
      query(filter, pageNumber)
    );
  }

  const filters = $derived([
    { value: "all", label: "All", count: data.counts.total },
    { value: "new", label: "New", count: data.counts.new },
    { value: "duplicate", label: "Duplicates", count: data.counts.duplicate },
  ]);

  const statusLabel = {
    new: "New",
    duplicate: "Duplicate",
    duplicate_in_file: "Duplicate in file",
  } as const;
</script>

{#snippet statusBadge(
  status: keyof typeof statusLabel,
  matchedBy: "id" | "legacy_id" | null,
)}
  {#if status === "new"}
    <Badge
      variant="outline"
      class="border-emerald-500/50 text-emerald-700 dark:text-emerald-400"
      >{statusLabel[status]}</Badge
    >
  {:else}
    <Badge variant="secondary">{statusLabel[status]}</Badge>
    {#if matchedBy === "legacy_id"}
      <div class="text-muted-foreground mt-1 text-xs">
        Matched an earlier import by its old id.
      </div>
    {/if}
  {/if}
{/snippet}

<svelte:head>
  <title>Review import · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <div class="grid gap-3">
    <h1 class="text-2xl font-semibold tracking-tight md:text-3xl">
      Review import
    </h1>
    <ImportSteps current={3} />
  </div>

  <Card.Root>
    <Card.Header>
      <Card.Title class="flex flex-wrap items-center gap-2">
        <span class="min-w-0 break-all">{data.fileName}</span>
        <Badge variant="outline">{FORMAT_LABELS[data.format]}</Badge>
      </Card.Title>
      <Card.Description>
        Into {data.account.name}{data.account.iban &&
        prefs.iban(data.account.iban)
          ? ` · ${prefs.iban(data.account.iban)}`
          : ""}
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-5">
      <dl class="grid grid-cols-2 gap-x-6 gap-y-4 text-sm md:grid-cols-4">
        <div class="col-span-2 min-w-0">
          <dt class="text-muted-foreground text-xs">Statement period</dt>
          <dd class="font-medium">
            {#if data.statement}
              {formatPeriod(
                data.statement.fromDate,
                data.statement.toDate,
                prefs.locale,
              )}
            {:else}
              <span class="text-muted-foreground font-normal">Unknown</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground text-xs">Opening balance</dt>
          <dd class="font-medium">
            {#if data.statement?.openingBalance}
              <Amount
                value={data.statement.openingBalance.amount}
                currency={data.statement.openingBalance.currency}
              />
              <div class="text-muted-foreground text-xs font-normal">
                {prefs.date(data.statement.openingBalance.date)}
              </div>
            {:else}
              <span class="text-muted-foreground font-normal">Not in file</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground text-xs">Closing balance</dt>
          <dd class="font-medium">
            {#if data.statement?.closingBalance}
              <Amount
                value={data.statement.closingBalance.amount}
                currency={data.statement.closingBalance.currency}
              />
              <div class="text-muted-foreground text-xs font-normal">
                {prefs.date(data.statement.closingBalance.date)}
              </div>
            {:else}
              <span class="text-muted-foreground font-normal">Not in file</span>
            {/if}
          </dd>
        </div>
      </dl>
      <dl class="grid grid-cols-3 gap-3 text-center">
        <div class="rounded-lg border p-3">
          <dt class="text-muted-foreground text-xs">New</dt>
          <dd class="text-xl font-semibold tabular-nums">{data.counts.new}</dd>
        </div>
        <div class="rounded-lg border p-3">
          <dt class="text-muted-foreground text-xs">Duplicates</dt>
          <dd class="text-xl font-semibold tabular-nums">
            {data.counts.duplicate}
          </dd>
        </div>
        <div class="rounded-lg border p-3">
          <dt class="text-muted-foreground text-xs">Total</dt>
          <dd class="text-xl font-semibold tabular-nums">
            {data.counts.total}
          </dd>
        </div>
      </dl>
    </Card.Content>
  </Card.Root>

  {#if data.alreadyImportedAt}
    <Alert.Root>
      <InfoIcon />
      <Alert.Title>This file was imported before</Alert.Title>
      <Alert.Description>
        <p>
          An identical file was imported <LocalTime
            ms={data.alreadyImportedAt}
            mode="datetime"
          />. Importing it again adds only transactions that are not in the
          account yet.
        </p>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if warningCount > 0}
    <Alert.Root
      class="border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200"
    >
      <TriangleAlertIcon />
      <Alert.Title>{plural(warningCount, "warning")}</Alert.Title>
      <Alert.Description class="text-inherit">
        <ul class="list-disc ps-4">
          {#each data.warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
          {#each data.balanceWarnings as w (w.code)}
            <li>
              {#if w.code === "opening_mismatch"}
                The file's opening balance (<Amount
                  value={w.fileAmount}
                  currency={w.currency}
                />
                on {prefs.date(w.date)}) does not match the ledger balance at
                the end of the previous day (<Amount
                  value={w.ledgerAmount}
                  currency={w.currency}
                />).
              {:else}
                After this import the ledger balance on {prefs.date(w.date)}
                would be
                <Amount value={w.ledgerAmount} currency={w.currency} />, but the
                file's closing balance is
                <Amount value={w.fileAmount} currency={w.currency} />.
              {/if}
              This usually means a gap between imports or missing transactions.
            </li>
          {/each}
        </ul>
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if data.errors.length > 0}
    <Alert.Root variant="destructive" class="border-destructive/40">
      <CircleAlertIcon />
      <Alert.Title>This file cannot be imported yet</Alert.Title>
      <Alert.Description>
        <ul class="list-disc ps-4">
          {#if data.needsMapping}
            <li>This file needs a column mapping before it can be imported.</li>
          {/if}
          {#each otherErrors as error (error)}
            <li>{error}</li>
          {/each}
        </ul>
        {#if data.needsMapping}
          <Button href={mappingHref} class="mt-3">Map columns</Button>
        {/if}
      </Alert.Description>
    </Alert.Root>
  {/if}

  {#if isTabular && !data.needsMapping}
    <div>
      <Button href={mappingHref} variant="secondary" size="sm">
        Edit column mapping
      </Button>
    </div>
  {/if}

  <section class="grid gap-3" aria-labelledby="rows-heading">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="rows-heading" class="text-lg font-semibold">Transactions</h2>
      <nav
        class="bg-muted text-muted-foreground inline-flex h-9 items-center rounded-lg p-[3px]"
        aria-label="Filter transactions"
      >
        {#each filters as tab (tab.value)}
          <a
            href="{resolve('/(app)/import/[pendingId]', {
              pendingId: data.pendingId,
            })}{query(tab.value, 1)}"
            aria-current={data.filter === tab.value ? "page" : undefined}
            class={cn(
              "inline-flex h-[calc(100%-1px)] items-center rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-colors",
              data.filter === tab.value
                ? "bg-background text-foreground dark:border-input dark:bg-input/30 shadow-sm"
                : "hover:text-foreground",
            )}
            data-sveltekit-noscroll
            data-sveltekit-keepfocus>{tab.label} ({tab.count})</a
          >
        {/each}
      </nav>
    </div>

    {#if data.rows.length === 0}
      <p
        class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
      >
        {#if data.counts.total === 0}
          No transactions could be read from this file.
        {:else}
          No {data.filter === "new" ? "new transactions" : "duplicates"} in this file.
        {/if}
      </p>
    {:else}
      <div class="hidden rounded-lg border md:block">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head class="w-28">Date</Table.Head>
              <Table.Head>Counterparty / description</Table.Head>
              <Table.Head class="text-end">Amount</Table.Head>
              <Table.Head class="w-40">Status</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.rows as row (row.index)}
              <Table.Row>
                <Table.Cell class="align-top whitespace-nowrap">
                  {prefs.date(row.tx.bookingDate)}
                </Table.Cell>
                <Table.Cell class="max-w-md align-top whitespace-normal">
                  <div class="font-medium break-words">
                    {row.tx.counterpartyName ?? row.tx.description ?? "—"}
                  </div>
                  {#if row.tx.counterpartyName && row.tx.description}
                    <div class="text-muted-foreground text-xs break-words">
                      {row.tx.description}
                    </div>
                  {/if}
                  {#if row.tx.reference}
                    <div
                      class="text-muted-foreground font-mono text-xs break-all"
                    >
                      {row.tx.reference}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-end align-top">
                  <Amount
                    value={row.tx.amount}
                    currency={row.tx.currency}
                    flow
                  />
                </Table.Cell>
                <Table.Cell class="align-top">
                  {@render statusBadge(row.status, row.matchedBy)}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>

      <ul class="divide-y rounded-lg border md:hidden">
        {#each data.rows as row (row.index)}
          <li class="grid gap-1 px-3 py-3 text-sm">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 font-medium break-words">
                {row.tx.counterpartyName ?? row.tx.description ?? "—"}
              </div>
              <Amount
                value={row.tx.amount}
                currency={row.tx.currency}
                flow
                class="font-medium"
              />
            </div>
            {#if row.tx.counterpartyName && row.tx.description}
              <div class="text-muted-foreground text-xs break-words">
                {row.tx.description}
              </div>
            {/if}
            {#if row.tx.reference}
              <div class="text-muted-foreground font-mono text-xs break-all">
                {row.tx.reference}
              </div>
            {/if}
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground text-xs">
                {prefs.date(row.tx.bookingDate)}
              </span>
              {@render statusBadge(row.status, row.matchedBy)}
            </div>
          </li>
        {/each}
      </ul>

      {#if data.pageCount > 1}
        <nav
          class="flex flex-wrap items-center justify-between gap-2 text-sm"
          aria-label="Pagination"
        >
          <span class="text-muted-foreground tabular-nums">
            {firstRow}–{lastRow} of {data.filteredTotal}
          </span>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              href={pageHref(data.filter, data.page - 1)}
              disabled={data.page <= 1}
              aria-disabled={data.page <= 1}
            >
              <ChevronLeftIcon /> Previous
            </Button>
            <span class="tabular-nums">{data.page} / {data.pageCount}</span>
            <Button
              variant="outline"
              size="sm"
              href={pageHref(data.filter, data.page + 1)}
              disabled={data.page >= data.pageCount}
              aria-disabled={data.page >= data.pageCount}
            >
              Next <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      {/if}
    {/if}
  </section>

  <div
    class="bg-background/95 sticky bottom-0 z-10 -mx-4 grid gap-2 border-t px-4 py-3 backdrop-blur md:-mx-6 md:px-6"
  >
    <FormAlert message={formError(confirmErrors) ?? formError(cancelErrors)} />
    <div class="flex flex-wrap items-center justify-between gap-3">
      <form
        method="POST"
        action="?/cancel"
        use:enhance={submitHandler({
          setPending: (v) => (cancelling = v),
          setErrors: (e) => (cancelErrors = e),
        })}
      >
        <Button type="submit" variant="outline" disabled={busy}>
          {#if cancelling}<Spinner />Cancelling…{:else}Cancel{/if}
        </Button>
      </form>
      <form
        method="POST"
        action="?/confirm"
        class="flex items-center gap-3"
        use:enhance={submitHandler({
          setPending: (v) => (confirming = v),
          setErrors: (e) => (confirmErrors = e),
        })}
      >
        <Button type="submit" disabled={busy || !data.canConfirm || nothingNew}>
          {#if confirming}<Spinner
            />Importing…{:else if data.canConfirm && nothingNew}Nothing new to
            import{:else}Import {plural(data.counts.new, "transaction")}{/if}
        </Button>
      </form>
    </div>
  </div>
</div>
