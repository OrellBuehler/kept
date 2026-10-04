<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { resolve } from "$app/paths";
  import { cn } from "$lib/utils";
  import * as Card from "$lib/components/ui/card";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Empty from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import CategoryBadge from "$lib/components/CategoryBadge.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import { minor, type ShareBasis } from "$lib/money";
  import { usePreferences } from "$lib/preferences.svelte";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PiggyBankIcon from "@lucide/svelte/icons/piggy-bank";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import type { PageData, PageProps } from "./$types";
  import BudgetFormDialog from "./BudgetFormDialog.svelte";

  type Row = PageData["report"]["currencies"][number]["rows"][number];

  const prefs = usePreferences();

  let { data }: PageProps = $props();

  let formOpen = $state(false);
  let editing = $state<{ row: Row; currency: string } | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<Row | null>(null);

  const monthLabel = $derived(prefs.month(data.month));
  const expenseCategories = $derived(
    data.categories.filter((c) => c.kind === "expense"),
  );

  function monthQuery(month: string) {
    const base = `?month=${month}`;
    return data.hasShared ? `${base}&basis=${data.basis}` : base;
  }
  function basisQuery(basis: ShareBasis) {
    return `?month=${data.month}&basis=${basis}`;
  }

  function openForm(row: Row | null, currency = "") {
    editing = row ? { row, currency } : null;
    formOpen = true;
  }

  function percent(spent: number, budget: number) {
    return Math.max(0, Math.min(100, Math.round((spent / budget) * 100)));
  }
</script>

<svelte:head>
  <title>Budgets · Kept</title>
</svelte:head>

<PageHeader title="Budgets" class="mb-6">
  {#snippet actions()}
    <nav class="flex items-center gap-1" aria-label="Month">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Previous month"
        href="{resolve('/(app)/budgets')}{monthQuery(data.previousMonth)}"
      >
        <ChevronLeftIcon />
      </Button>
      <span class="min-w-32 text-center text-sm font-medium">{monthLabel}</span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Next month"
        href="{resolve('/(app)/budgets')}{monthQuery(data.nextMonth)}"
      >
        <ChevronRightIcon />
      </Button>
      {#if data.month !== data.currentMonth}
        <Button
          variant="ghost"
          size="sm"
          href="{resolve('/(app)/budgets')}{monthQuery(data.currentMonth)}"
        >
          This month
        </Button>
      {/if}
    </nav>
    <Button
      size="sm"
      onclick={() => openForm(null)}
      disabled={expenseCategories.length === 0}
    >
      <PlusIcon /> Add budget
    </Button>
  {/snippet}
</PageHeader>

{#if data.hasShared}
  <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
    <nav
      class="bg-muted inline-flex rounded-lg p-0.5"
      aria-label="Count shared accounts"
    >
      {#each [{ value: "share", label: "My share" }, { value: "total", label: "Total" }] as option (option.value)}
        <a
          href="{resolve('/(app)/budgets')}{basisQuery(
            option.value as ShareBasis,
          )}"
          data-sveltekit-noscroll
          aria-current={data.basis === option.value ? "page" : undefined}
          class={cn(
            "focus-visible:ring-ring/50 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
            data.basis === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}>{option.label}</a
        >
      {/each}
    </nav>
    <p class="text-muted-foreground text-xs">
      {data.basis === "share"
        ? "Spending on shared accounts is counted at your ownership share."
        : "Spending on shared accounts is counted in full."}
    </p>
  </div>
{/if}

{#if expenseCategories.length === 0}
  <Empty.Root class="border border-dashed">
    <Empty.Header>
      <Empty.Media variant="icon"><PiggyBankIcon /></Empty.Media>
      <Empty.Title>Create a category first</Empty.Title>
      <Empty.Description>
        Budgets are set per expense category. Add categories in the settings,
        then give each transaction a category.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <Button href={resolve("/(app)/settings/categories")}>
        Manage categories
      </Button>
    </Empty.Content>
  </Empty.Root>
{:else if data.report.currencies.length === 0}
  <Empty.Root class="border border-dashed">
    <Empty.Header>
      <Empty.Media variant="icon"><PiggyBankIcon /></Empty.Media>
      <Empty.Title>No budgets or spending in {monthLabel}</Empty.Title>
      <Empty.Description>
        Add a monthly budget for a category to see how much of it is spent.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <Button onclick={() => openForm(null)}>
        <PlusIcon /> Add budget
      </Button>
    </Empty.Content>
  </Empty.Root>
{:else}
  <div class="grid gap-4">
    {#each data.report.currencies as report (report.currency)}
      <Card.Root>
        <Card.Header>
          <Card.Title>{report.currency}</Card.Title>
          <Card.Description>
            {#if report.rows.length > 0}
              <Amount
                value={report.totalSpent}
                currency={report.currency}
                class="text-foreground"
              />
              spent of
              <Amount
                value={report.totalBudget}
                currency={report.currency}
                class="text-foreground"
              />
              budgeted
            {:else}
              No budgets in this currency.
            {/if}
          </Card.Description>
        </Card.Header>
        <Card.Content class="space-y-4">
          {#if report.rows.length > 0}
            <ul class="divide-y">
              {#each report.rows as row (row.budgetId)}
                <li class="py-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2">
                      {#if row.parentName}
                        <span class="text-muted-foreground ps-3 text-xs">↳</span
                        >
                      {/if}
                      <CategoryBadge
                        name={row.categoryName}
                        color={row.color}
                        icon={row.icon}
                        class="text-sm font-medium"
                      />
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <span class="text-sm tabular-nums">
                        <Amount
                          value={row.spent}
                          currency={report.currency}
                          class={cn(row.over && "text-destructive font-medium")}
                        />
                        <span class="text-muted-foreground">of</span>
                        <Amount value={row.budget} currency={report.currency} />
                      </span>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger>
                          {#snippet child({ props })}
                            <Button
                              {...props}
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Actions for {row.categoryName}"
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          {/snippet}
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content align="end">
                          <DropdownMenu.Item
                            onSelect={() => openForm(row, report.currency)}
                          >
                            <PencilIcon /> Edit
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            variant="destructive"
                            onSelect={() => {
                              deleting = row;
                              deleteOpen = true;
                            }}
                          >
                            <Trash2Icon /> Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </div>
                  </div>
                  <div
                    class="bg-muted mt-2 h-2 overflow-hidden rounded-full"
                    role="progressbar"
                    aria-label="{row.categoryName} spent"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent(row.spent, row.budget)}
                  >
                    <div
                      class={cn(
                        "h-full rounded-full",
                        row.over ? "bg-destructive" : "bg-primary",
                      )}
                      style:width="{percent(row.spent, row.budget)}%"
                    ></div>
                  </div>
                  <p
                    class={cn(
                      "mt-1 text-xs",
                      row.over ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {#if row.over}
                      Over by
                      <Amount
                        value={minor(-row.remaining)}
                        currency={report.currency}
                        class="text-destructive"
                      />
                    {:else}
                      <Amount
                        value={row.remaining}
                        currency={report.currency}
                        class="text-muted-foreground"
                      /> left
                    {/if}
                  </p>
                </li>
              {/each}
            </ul>
          {/if}

          {#if report.unbudgeted.length > 0}
            <div>
              <h3 class="mb-2 text-sm font-medium">Spent without a budget</h3>
              <ul class="divide-y">
                {#each report.unbudgeted as row (row.categoryId)}
                  <li class="flex items-center justify-between gap-3 py-2">
                    <CategoryBadge
                      name={row.parentName
                        ? `${row.parentName} / ${row.categoryName}`
                        : row.categoryName}
                      color={row.color}
                      icon={row.icon}
                      class="text-sm"
                    />
                    <Amount
                      value={row.spent}
                      currency={report.currency}
                      class="text-sm"
                    />
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    {/each}
  </div>
{/if}

<BudgetFormDialog
  bind:open={formOpen}
  budget={editing?.row ?? null}
  currency={editing?.currency ?? ""}
  categories={expenseCategories}
  currencies={data.currencies}
/>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete the budget for {deleting?.categoryName ?? 'this category'}?"
  description="Your transactions are not affected."
  action="?/deleteBudget"
  fields={{ id: deleting?.budgetId ?? "" }}
  successMessage="Budget deleted"
/>
