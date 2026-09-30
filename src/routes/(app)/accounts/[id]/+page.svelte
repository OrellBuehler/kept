<script lang="ts">
  import { enhance } from "$app/forms";
  import { afterNavigate, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import AccountFormDialog from "$lib/components/AccountFormDialog.svelte";
  import AccountTypeBadge from "$lib/components/AccountTypeBadge.svelte";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import { submitHandler } from "$lib/form-submit";
  import ArchiveIcon from "@lucide/svelte/icons/archive";
  import ArchiveRestoreIcon from "@lucide/svelte/icons/archive-restore";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import SnapshotsCard from "./SnapshotsCard.svelte";
  import TransactionForm from "./TransactionForm.svelte";
  import TransactionSheet from "./TransactionSheet.svelte";
  import TransactionsCard from "./TransactionsCard.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const account = $derived(data.account);
  const currencyLocked = $derived(
    account.lastBookingDate !== null || data.snapshots.length > 0,
  );

  let editOpen = $state(false);
  let deleteAccountOpen = $state(false);
  let addTxOpen = $state(false);
  let sheetOpen = $state(false);
  let selectedId = $state<string | null>(null);
  let deleteTxOpen = $state(false);
  let deletingTxId = $state("");
  let archiveForm = $state<HTMLFormElement | null>(null);
  let archiving = $state(false);

  const selected = $derived(
    data.transactions.items.find((t) => t.id === selectedId) ?? null,
  );

  afterNavigate(() => {
    // The import flow redirects here with ?imported=<id>; show it once, then
    // drop the param so a reload does not repeat the toast.
    if (page.url.searchParams.has("imported")) {
      toast.success("Import complete");
      // The client router is not ready during the initial navigation.
      setTimeout(() => {
        replaceState(
          resolve("/(app)/accounts/[id]", { id: account.id }),
          page.state,
        );
      }, 0);
    }
  });

  async function copyIban() {
    if (!account.iban) return;
    try {
      await navigator.clipboard.writeText(account.iban);
      toast.success("IBAN copied");
    } catch (err) {
      console.error("clipboard write failed", err);
      toast.error("Could not copy the IBAN.");
    }
  }
</script>

<svelte:head>
  <title>{account.name} · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <div class="grid gap-3">
    <Button
      variant="ghost"
      size="sm"
      href="/accounts"
      class="text-muted-foreground -ms-2 w-fit"
    >
      <ChevronLeftIcon /> Accounts
    </Button>

    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="grid min-w-0 gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-semibold tracking-tight break-words">
            {account.name}
          </h1>
          <AccountTypeBadge type={account.type} />
          {#if account.archived}
            <Badge variant="outline">Archived</Badge>
          {/if}
        </div>
        <div
          class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
        >
          {#if account.institution}
            <span class="flex items-center gap-1.5">
              <span
                class="bg-muted-foreground/40 size-2.5 rounded-full"
                style:background-color={account.institution.color}
                aria-hidden="true"
              ></span>
              {account.institution.name}
            </span>
          {/if}
          {#if account.ibanMasked}
            <span class="flex items-center gap-1">
              <span class="font-mono">{account.ibanMasked}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                class="size-7"
                onclick={copyIban}
                aria-label="Copy IBAN"
              >
                <CopyIcon />
              </Button>
            </span>
          {/if}
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div class="text-end">
          <div class="text-muted-foreground text-xs">Current balance</div>
          <Amount
            value={data.balance}
            currency={account.currency}
            class="text-3xl font-semibold"
          />
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="outline"
                size="icon"
                aria-label="Account actions"
                disabled={archiving}
              >
                <MoreHorizontalIcon />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-56">
            <DropdownMenu.Item onSelect={() => (editOpen = true)}>
              <PencilIcon /> Edit
            </DropdownMenu.Item>
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- route is added by the import flow -->
                <a href="/import?account={account.id}" {...props}>
                  <UploadIcon /> Import statement
                </a>
              {/snippet}
            </DropdownMenu.Item>
            <DropdownMenu.Item>
              {#snippet child({ props })}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- route is added by the import flow -->
                <a href="/accounts/{account.id}/imports" {...props}>
                  <HistoryIcon /> Import history
                </a>
              {/snippet}
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => archiveForm?.requestSubmit()}>
              {#if account.archived}
                <ArchiveRestoreIcon /> Unarchive
              {:else}
                <ArchiveIcon /> Archive
              {/if}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              variant="destructive"
              onSelect={() => (deleteAccountOpen = true)}
            >
              <Trash2Icon /> Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  </div>

  <TransactionsCard
    accountId={account.id}
    currency={account.currency}
    transactions={data.transactions}
    filters={data.filters}
    filterErrors={data.filterErrors}
    onSelect={(tx) => {
      selectedId = tx.id;
      sheetOpen = true;
    }}
    onAdd={() => (addTxOpen = true)}
  />

  <SnapshotsCard snapshots={data.snapshots} currency={account.currency} />
</div>

<form
  method="POST"
  action={account.archived ? "?/unarchive" : "?/archive"}
  bind:this={archiveForm}
  class="hidden"
  use:enhance={submitHandler({
    setPending: (v) => (archiving = v),
    setErrors: (e) => {
      const message = Object.values(e).flat()[0];
      if (message) toast.error(message);
    },
    successMessage: account.archived
      ? "Account unarchived"
      : "Account archived",
  })}
></form>

<Dialog.Root bind:open={addTxOpen}>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Add transaction</Dialog.Title>
      <Dialog.Description>
        Record a payment by hand, in {account.currency}.
      </Dialog.Description>
    </Dialog.Header>
    <TransactionForm
      action="?/addTransaction"
      currency={account.currency}
      submitLabel="Add transaction"
      successMessage="Transaction added"
      onSuccess={() => (addTxOpen = false)}
      onCancel={() => (addTxOpen = false)}
    />
  </Dialog.Content>
</Dialog.Root>

<TransactionSheet
  bind:open={sheetOpen}
  transaction={selected}
  currency={account.currency}
  onDelete={(tx) => {
    deletingTxId = tx.id;
    sheetOpen = false;
    deleteTxOpen = true;
  }}
/>

<ConfirmActionDialog
  bind:open={deleteTxOpen}
  title="Delete this transaction?"
  description="This manual transaction will be removed and the balance recalculated."
  action="?/deleteTransaction"
  fields={{ transactionId: deletingTxId }}
  successMessage="Transaction deleted"
/>

<AccountFormDialog
  bind:open={editOpen}
  action="?/updateAccount"
  institutions={data.institutions}
  {account}
  {currencyLocked}
/>

<ConfirmActionDialog
  bind:open={deleteAccountOpen}
  title="Delete {account.name}?"
  description="All transactions and balance snapshots of this account are deleted permanently, including imported ones. This cannot be undone. Archive the account instead to hide it and keep its history."
  action="?/deleteAccount"
  confirmText={account.name}
  confirmLabel="Delete account"
  successMessage="Account deleted"
/>
