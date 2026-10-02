<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { resolve } from "$app/paths";
  import * as Card from "$lib/components/ui/card";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Empty from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import AccountFormDialog from "$lib/components/AccountFormDialog.svelte";
  import AccountTypeBadge from "$lib/components/AccountTypeBadge.svelte";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import InstitutionFormDialog from "$lib/components/InstitutionFormDialog.svelte";
  import { daysSince, formatAgo } from "$lib/format";
  import { minor, type Minor } from "$lib/money";
  import LandmarkIcon from "@lucide/svelte/icons/landmark";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import type { PageData, PageProps } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  type Account = PageData["accounts"][number];
  type Institution = PageData["institutions"][number];

  const STALE_DAYS = 45;

  let { data }: PageProps = $props();

  let showArchived = $state(false);
  let accountOpen = $state(false);
  let accountInstitutionId = $state("");
  let institutionOpen = $state(false);
  let editingInstitution = $state<Institution | null>(null);
  let deleteInstitutionOpen = $state(false);
  let deletingInstitution = $state<Institution | null>(null);

  const now = Date.now();

  const active = $derived(data.accounts.filter((a) => !a.archived));
  const archivedCount = $derived(data.accounts.length - active.length);
  const visible = $derived(showArchived ? data.accounts : active);

  const totals = $derived.by(() => {
    const currencies = [...new Set(active.map((a) => a.currency))].sort();
    return currencies.map((currency) => ({
      currency,
      sum: minor(
        active
          .filter((a) => a.currency === currency)
          .reduce((sum, a) => sum + a.balance, 0),
      ) as Minor,
    }));
  });

  const groups = $derived.by(() => {
    const result: {
      key: string;
      institution: Institution | null;
      accounts: Account[];
    }[] = data.institutions.map((institution) => ({
      key: institution.id,
      institution,
      accounts: visible.filter((a) => a.institution?.id === institution.id),
    }));
    const other = visible.filter((a) => a.institution === null);
    if (other.length > 0) {
      result.push({ key: "other", institution: null, accounts: other });
    }
    return result;
  });

  function openAddAccount(institutionId = "") {
    accountInstitutionId = institutionId;
    accountOpen = true;
  }
  function openAddInstitution() {
    editingInstitution = null;
    institutionOpen = true;
  }
  function openEditInstitution(i: Institution) {
    editingInstitution = i;
    institutionOpen = true;
  }
  function askDeleteInstitution(i: Institution) {
    deletingInstitution = i;
    deleteInstitutionOpen = true;
  }
  function staleAgo(a: Account) {
    if (a.lastImportAt === null || daysSince(a.lastImportAt, now) <= STALE_DAYS)
      return null;
    return formatAgo(a.lastImportAt, now);
  }
</script>

<svelte:head>
  <title>Accounts · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <PageHeader title="Accounts">
    {#snippet actions()}
      {#if archivedCount > 0}
        <div class="flex items-center gap-2 pe-2">
          <Switch id="show-archived" bind:checked={showArchived} />
          <Label for="show-archived" class="text-sm font-normal">
            Show archived ({archivedCount})
          </Label>
        </div>
      {/if}
      <Button variant="outline" onclick={openAddInstitution}>
        <PlusIcon /> Add institution
      </Button>
      <Button onclick={() => openAddAccount()}>
        <PlusIcon /> Add account
      </Button>
    {/snippet}
  </PageHeader>

  {#if data.accounts.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><LandmarkIcon /></Empty.Media>
        <Empty.Title>Welcome to Kept</Empty.Title>
        <Empty.Description>
          Kept keeps your accounts, transactions and bills in one place that you
          host yourself. Add an institution and an account, then import your
          statements.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <div class="flex flex-wrap justify-center gap-2">
          <Button onclick={() => openAddAccount()}>
            <PlusIcon /> Add account
          </Button>
          <Button variant="outline" onclick={openAddInstitution}>
            <PlusIcon /> Add institution
          </Button>
        </div>
      </Empty.Content>
    </Empty.Root>
  {:else if totals.length > 0}
    <section aria-label="Totals" class="grid gap-3">
      <div class="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        {#each totals as t (t.currency)}
          <Card.Root class="gap-1 py-4">
            <Card.Header class="px-4">
              <Card.Description>Total {t.currency}</Card.Description>
              <Card.Title class="text-2xl">
                <Amount value={t.sum} currency={t.currency} />
              </Card.Title>
            </Card.Header>
          </Card.Root>
        {/each}
      </div>
      <p class="text-muted-foreground text-xs">
        Sum of active accounts per currency. Currencies are not converted.
      </p>
    </section>
  {/if}

  {#if data.accounts.length > 0 && visible.length === 0}
    <p class="text-muted-foreground text-sm">
      All accounts are archived. Turn on "Show archived" to see them.
    </p>
  {/if}

  {#each groups as group (group.key)}
    {#if group.accounts.length > 0 || group.institution}
      <section
        class="grid gap-2"
        aria-label={group.institution?.name ?? "Other"}
      >
        <div class="flex items-center justify-between gap-2">
          <h2 class="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span
              class="bg-muted-foreground/30 size-3 shrink-0 rounded-full"
              style:background-color={group.institution?.color}
              aria-hidden="true"
            ></span>
            <span class="truncate">{group.institution?.name ?? "Other"}</span>
            {#if group.institution?.bic}
              <span class="text-muted-foreground font-mono text-xs font-normal">
                {group.institution.bic}
              </span>
            {/if}
          </h2>
          {#if group.institution}
            {@const institution = group.institution}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Actions for {institution.name}"
                  >
                    <MoreHorizontalIcon />
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end">
                <DropdownMenu.Item
                  onSelect={() => openAddAccount(institution.id)}
                >
                  <PlusIcon /> Add account
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => openEditInstitution(institution)}
                >
                  <PencilIcon /> Edit
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  variant="destructive"
                  onSelect={() => askDeleteInstitution(institution)}
                >
                  <Trash2Icon /> Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/if}
        </div>

        {#if group.accounts.length === 0}
          <p
            class="text-muted-foreground rounded-md border border-dashed p-3 text-sm"
          >
            {group.institution?.accountCount
              ? "All accounts of this institution are archived."
              : "No accounts yet."}
          </p>
        {:else}
          <ul class="divide-y rounded-lg border">
            {#each group.accounts as account (account.id)}
              {@const ago = staleAgo(account)}
              <li>
                <a
                  href={resolve("/(app)/accounts/[id]", { id: account.id })}
                  class="hover:bg-muted/50 focus-visible:ring-ring/50 flex items-start justify-between gap-4 p-4 outline-none focus-visible:ring-[3px]"
                >
                  <div class="grid min-w-0 gap-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="truncate font-medium">{account.name}</span>
                      <AccountTypeBadge type={account.type} />
                      {#if account.archived}
                        <Badge variant="outline">Archived</Badge>
                      {/if}
                    </div>
                    {#if account.iban && prefs.ibanDisplay !== "hidden"}
                      <span class="text-muted-foreground font-mono text-xs">
                        {prefs.iban(account.iban)}
                      </span>
                    {/if}
                    <span class="text-muted-foreground text-xs">
                      {#if account.lastBookingDate}
                        Last booking {prefs.date(account.lastBookingDate)}
                      {:else}
                        No transactions yet
                      {/if}
                    </span>
                    {#if ago}
                      <span
                        class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                      >
                        <TriangleAlertIcon class="size-3.5" />
                        Last import {ago}
                      </span>
                    {/if}
                  </div>
                  <Amount
                    value={account.balance}
                    currency={account.currency}
                    class="shrink-0 text-end text-lg font-semibold"
                  />
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/each}
</div>

<AccountFormDialog
  bind:open={accountOpen}
  action="?/createAccount"
  institutions={data.institutions}
  defaultInstitutionId={accountInstitutionId}
/>

<InstitutionFormDialog
  bind:open={institutionOpen}
  institution={editingInstitution}
/>

<ConfirmActionDialog
  bind:open={deleteInstitutionOpen}
  title="Delete {deletingInstitution?.name ?? 'institution'}?"
  description="Only institutions without accounts can be deleted. Move or delete its accounts first."
  action="?/deleteInstitution"
  fields={{ id: deletingInstitution?.id ?? "" }}
  successMessage="Institution deleted"
/>
