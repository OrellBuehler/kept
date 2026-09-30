<script lang="ts">
  import { resolve } from "$app/paths";
  import { toast } from "svelte-sonner";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import UndoIcon from "@lucide/svelte/icons/undo-2";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Empty from "$lib/components/ui/empty";
  import * as Table from "$lib/components/ui/table";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import LocalTime from "$lib/components/import/LocalTime.svelte";
  import { FORMAT_LABELS, formatPeriod, plural } from "$lib/import-ui";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const account = $derived(data.account);
  const importHref = $derived(
    `${resolve("/(app)/import")}?account=${encodeURIComponent(account.id)}`,
  );

  let undoOpen = $state(false);
  let target = $state<(typeof data.imports)[number] | null>(null);
  let expanded = $state<Record<string, boolean>>({});

  let handled: unknown = null;
  $effect(() => {
    if (form && "success" in form && form.success && form !== handled) {
      handled = form;
      toast.success(
        `Import undone. ${plural(form.removedTransactions, "transaction")} removed.`,
      );
    }
  });

  function askUndo(imp: (typeof data.imports)[number]) {
    target = imp;
    undoOpen = true;
  }
</script>

<svelte:head>
  <title>Import history · {account.name} · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <div class="grid gap-3">
    <Button
      variant="ghost"
      size="sm"
      href={resolve("/(app)/accounts/[id]", { id: account.id })}
      class="text-muted-foreground -ms-2 w-fit"
    >
      <ChevronLeftIcon />
      {account.name}
    </Button>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Import history</h1>
      <Button href={importHref}><UploadIcon />Import transactions</Button>
    </div>
  </div>

  {#if data.imports.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><HistoryIcon /></Empty.Media>
        <Empty.Title>No imports yet</Empty.Title>
        <Empty.Description>
          Statements you import into {account.name} are listed here, and you can undo
          them.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href={importHref}>Import a statement</Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <div class="hidden rounded-lg border md:block">
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Imported</Table.Head>
            <Table.Head>File</Table.Head>
            <Table.Head>Period</Table.Head>
            <Table.Head class="text-end">Opening → closing</Table.Head>
            <Table.Head class="text-end">New / duplicate</Table.Head>
            <Table.Head class="w-24"
              ><span class="sr-only">Actions</span></Table.Head
            >
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each data.imports as imp (imp.id)}
            <Table.Row>
              <Table.Cell class="align-top whitespace-nowrap">
                <LocalTime ms={imp.createdAt} mode="datetime" />
              </Table.Cell>
              <Table.Cell class="max-w-64 align-top whitespace-normal">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="break-all">{imp.fileName}</span>
                  <Badge variant="outline">{FORMAT_LABELS[imp.format]}</Badge>
                </div>
                {#if imp.warnings.length > 0}
                  <Collapsible.Root bind:open={expanded[imp.id]} class="mt-2">
                    <Collapsible.Trigger
                      class="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
                    >
                      <TriangleAlertIcon class="size-3.5" />
                      {plural(imp.warnings.length, "warning")}
                      <ChevronDownIcon class="size-3.5" />
                    </Collapsible.Trigger>
                    <Collapsible.Content>
                      <ul
                        class="text-muted-foreground mt-1 list-disc ps-4 text-xs"
                      >
                        {#each imp.warnings as warning (warning)}
                          <li>{warning}</li>
                        {/each}
                      </ul>
                    </Collapsible.Content>
                  </Collapsible.Root>
                {/if}
              </Table.Cell>
              <Table.Cell class="align-top whitespace-nowrap">
                {formatPeriod(imp.statementFrom, imp.statementTo)}
              </Table.Cell>
              <Table.Cell class="text-end align-top">
                {#if imp.openingBalance !== null || imp.closingBalance !== null}
                  <div class="flex flex-wrap items-center justify-end gap-x-1">
                    {#if imp.openingBalance !== null}
                      <Amount
                        value={imp.openingBalance}
                        currency={imp.currency}
                      />
                    {:else}<span class="text-muted-foreground">—</span>{/if}
                    <span class="text-muted-foreground">→</span>
                    {#if imp.closingBalance !== null}
                      <Amount
                        value={imp.closingBalance}
                        currency={imp.currency}
                      />
                    {:else}<span class="text-muted-foreground">—</span>{/if}
                  </div>
                {:else}
                  <span class="text-muted-foreground">—</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-end align-top tabular-nums">
                {imp.newCount} / {imp.duplicateCount}
              </Table.Cell>
              <Table.Cell class="text-end align-top">
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => askUndo(imp)}
                >
                  <UndoIcon />Undo
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>

    <ul class="divide-y rounded-lg border md:hidden">
      {#each data.imports as imp (imp.id)}
        <li class="grid gap-2 px-3 py-3 text-sm">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-medium break-all">{imp.fileName}</div>
              <LocalTime
                ms={imp.createdAt}
                mode="datetime"
                class="text-muted-foreground text-xs"
              />
            </div>
            <Badge variant="outline">{FORMAT_LABELS[imp.format]}</Badge>
          </div>
          <div class="text-muted-foreground">
            {formatPeriod(imp.statementFrom, imp.statementTo)}
          </div>
          {#if imp.openingBalance !== null || imp.closingBalance !== null}
            <div class="flex flex-wrap items-center gap-x-1">
              {#if imp.openingBalance !== null}
                <Amount value={imp.openingBalance} currency={imp.currency} />
              {:else}<span class="text-muted-foreground">—</span>{/if}
              <span class="text-muted-foreground">→</span>
              {#if imp.closingBalance !== null}
                <Amount value={imp.closingBalance} currency={imp.currency} />
              {:else}<span class="text-muted-foreground">—</span>{/if}
            </div>
          {/if}
          <div class="flex items-center justify-between gap-2">
            <span class="tabular-nums"
              >{imp.newCount} new · {imp.duplicateCount} duplicate</span
            >
            <Button variant="outline" size="sm" onclick={() => askUndo(imp)}>
              <UndoIcon />Undo
            </Button>
          </div>
          {#if imp.warnings.length > 0}
            <Collapsible.Root bind:open={expanded[imp.id]}>
              <Collapsible.Trigger
                class="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
              >
                <TriangleAlertIcon class="size-3.5" />
                {plural(imp.warnings.length, "warning")}
                <ChevronDownIcon class="size-3.5" />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <ul class="text-muted-foreground mt-1 list-disc ps-4 text-xs">
                  {#each imp.warnings as warning (warning)}
                    <li>{warning}</li>
                  {/each}
                </ul>
              </Collapsible.Content>
            </Collapsible.Root>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<ConfirmActionDialog
  bind:open={undoOpen}
  title="Undo this import?"
  description={`Removes the ${plural(target?.newCount ?? 0, "transaction")} this import added. Transactions also contained in later imports are removed too because they were first added by this import.`}
  action="?/undo"
  fields={{ importId: target?.id ?? "" }}
  confirmLabel="Undo import"
>
  {#if target}
    <p class="text-muted-foreground text-sm break-all">{target.fileName}</p>
  {/if}
</ConfirmActionDialog>
