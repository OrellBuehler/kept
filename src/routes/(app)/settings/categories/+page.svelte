<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import * as Card from "$lib/components/ui/card";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import CategoryBadge from "$lib/components/CategoryBadge.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import { categoryLabel } from "$lib/category-types";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlayIcon from "@lucide/svelte/icons/play";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TagsIcon from "@lucide/svelte/icons/tags";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import type { PageData, PageProps } from "./$types";
  import CategoryFormDialog from "./CategoryFormDialog.svelte";
  import RuleFormDialog from "./RuleFormDialog.svelte";

  type Category = PageData["categories"][number];
  type Rule = PageData["rules"][number];

  let { data }: PageProps = $props();

  let categoryOpen = $state(false);
  let editingCategory = $state<Category | null>(null);
  let deleteCategoryOpen = $state(false);
  let deletingCategory = $state<Category | null>(null);
  let ruleOpen = $state(false);
  let editingRule = $state<Rule | null>(null);
  let deleteRuleOpen = $state(false);
  let deletingRule = $state<Rule | null>(null);
  let applying = $state(false);

  const topLevel = $derived(data.categories.filter((c) => c.parentId === null));

  function conditions(rule: Rule) {
    const out: string[] = [];
    if (rule.counterpartyContains)
      out.push(`counterparty contains "${rule.counterpartyContains}"`);
    if (rule.descriptionContains)
      out.push(`description contains "${rule.descriptionContains}"`);
    if (rule.counterpartyIban) out.push(`IBAN is ${rule.counterpartyIban}`);
    if (rule.amountSign === "income") out.push("money in");
    if (rule.amountSign === "expense") out.push("money out");
    return out.join(" and ");
  }

  function openCategory(category: Category | null) {
    editingCategory = category;
    categoryOpen = true;
  }
  function openRule(rule: Rule | null) {
    editingRule = rule;
    ruleOpen = true;
  }
</script>

<svelte:head>
  <title>Categories · Kept</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight">Categories</h1>

<div class="grid gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Categories</Card.Title>
      <Card.Description>
        Label transactions as expenses or income, optionally one level of
        subcategories. Set a category on any transaction in an account.
      </Card.Description>
      <Card.Action>
        <Button size="sm" onclick={() => openCategory(null)}>
          <PlusIcon /> Add category
        </Button>
      </Card.Action>
    </Card.Header>
    <Card.Content>
      {#if data.categories.length === 0}
        <Empty.Root class="border border-dashed">
          <Empty.Header>
            <Empty.Media variant="icon"><TagsIcon /></Empty.Media>
            <Empty.Title>No categories yet</Empty.Title>
            <Empty.Description>
              Create your own, for example "Groceries" or "Salary".
            </Empty.Description>
          </Empty.Header>
          <Empty.Content>
            <Button onclick={() => openCategory(null)}>
              <PlusIcon /> Add category
            </Button>
          </Empty.Content>
        </Empty.Root>
      {:else}
        <ul class="divide-y">
          {#each data.categories as category (category.id)}
            <li
              class="flex items-center justify-between gap-3 py-2"
              class:ps-6={category.parentId !== null}
            >
              <div class="flex min-w-0 items-center gap-3">
                <CategoryBadge
                  name={category.name}
                  color={category.color}
                  icon={category.icon}
                  class="font-medium"
                />
                <Badge
                  variant={category.kind === "income" ? "default" : "secondary"}
                >
                  {category.kind === "income" ? "Income" : "Expense"}
                </Badge>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span class="text-muted-foreground hidden text-xs sm:inline">
                  {category.transactionCount}
                  {category.transactionCount === 1
                    ? "transaction"
                    : "transactions"}
                </span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                      <Button
                        {...props}
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Actions for {category.name}"
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    {/snippet}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    <DropdownMenu.Item onSelect={() => openCategory(category)}>
                      <PencilIcon /> Edit
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      variant="destructive"
                      onSelect={() => {
                        deletingCategory = category;
                        deleteCategoryOpen = true;
                      }}
                    >
                      <Trash2Icon /> Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Rules</Card.Title>
      <Card.Description>
        Rules categorize new transactions when you import them. The first
        matching rule wins, lowest priority number first. A category you set by
        hand is never changed by a rule.
      </Card.Description>
      <Card.Action class="flex gap-2">
        <form
          method="POST"
          action="?/applyRules"
          use:enhance={() => {
            applying = true;
            return async ({ result, update }) => {
              applying = false;
              if (result.type === "success") {
                const { categorized, scanned } = result.data as {
                  categorized: number;
                  scanned: number;
                };
                toast.success(
                  `Categorized ${categorized} of ${scanned} uncategorized ${scanned === 1 ? "transaction" : "transactions"}.`,
                );
                await update({ reset: false });
              } else {
                toast.error("Something went wrong. Please try again.");
              }
            };
          }}
        >
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={applying || data.rules.length === 0}
          >
            {#if applying}<Spinner />{:else}<PlayIcon />{/if}
            Run on uncategorized
          </Button>
        </form>
        <Button
          size="sm"
          onclick={() => openRule(null)}
          disabled={data.categories.length === 0}
        >
          <PlusIcon /> Add rule
        </Button>
      </Card.Action>
    </Card.Header>
    <Card.Content>
      {#if data.rules.length === 0}
        <p class="text-muted-foreground text-sm">
          {data.categories.length === 0
            ? "Add a category first, then create rules for it."
            : "No rules yet."}
        </p>
      {:else}
        <ul class="divide-y">
          {#each data.rules as rule (rule.id)}
            {@const category = data.categories.find(
              (c) => c.id === rule.categoryId,
            )}
            <li class="flex items-center justify-between gap-3 py-2">
              <div class="min-w-0">
                <p class="text-sm">
                  If {conditions(rule)}
                </p>
                <p class="text-muted-foreground text-xs">
                  then {category
                    ? categoryLabel(category, data.categories)
                    : rule.categoryName} · priority {rule.priority}
                </p>
              </div>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Actions for rule"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item onSelect={() => openRule(rule)}>
                    <PencilIcon /> Edit
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    variant="destructive"
                    onSelect={() => {
                      deletingRule = rule;
                      deleteRuleOpen = true;
                    }}
                  >
                    <Trash2Icon /> Delete
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<CategoryFormDialog
  bind:open={categoryOpen}
  category={editingCategory}
  {topLevel}
/>

<RuleFormDialog
  bind:open={ruleOpen}
  rule={editingRule}
  categories={data.categories}
/>

<ConfirmActionDialog
  bind:open={deleteCategoryOpen}
  title="Delete {deletingCategory?.name ?? 'category'}?"
  description="Its transactions become uncategorized and its rules and budgets are deleted. Subcategories stay as top-level categories."
  action="?/deleteCategory"
  fields={{ id: deletingCategory?.id ?? "" }}
  successMessage="Category deleted"
/>

<ConfirmActionDialog
  bind:open={deleteRuleOpen}
  title="Delete this rule?"
  description="Transactions already categorized by it keep their category."
  action="?/deleteRule"
  fields={{ id: deletingRule?.id ?? "" }}
  successMessage="Rule deleted"
/>
