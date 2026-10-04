<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Empty from "$lib/components/ui/empty";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import { PILLAR_3A_CURRENCY, type GapYear } from "$lib/pillar-3a";
  import type { Pillar3aContributionKind } from "$lib/pillar-3a-types";
  import type {
    ContributionView,
    Pillar3aPortfolioOverview,
  } from "$lib/server/pillar3a";
  import { usePreferences } from "$lib/preferences.svelte";
  import ArrowDownToLineIcon from "@lucide/svelte/icons/arrow-down-to-line";
  import HandCoinsIcon from "@lucide/svelte/icons/hand-coins";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import ContributionDialog from "./ContributionDialog.svelte";

  const prefs = usePreferences();
  const currency = PILLAR_3A_CURRENCY;

  let {
    contributions,
    portfolios,
    gaps,
  }: {
    contributions: ContributionView[];
    portfolios: Pillar3aPortfolioOverview[];
    gaps: GapYear[];
  } = $props();

  let year = $state("all");
  const years = $derived(
    [...new Set(contributions.map((c) => c.year))].toSorted((a, b) => b - a),
  );
  const visible = $derived(
    year === "all"
      ? contributions
      : contributions.filter((c) => String(c.year) === year),
  );

  let dialogOpen = $state(false);
  let editing = $state<ContributionView | null>(null);
  let preset = $state<Pillar3aContributionKind | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<ContributionView | null>(null);

  function add() {
    editing = null;
    preset = null;
    dialogOpen = true;
  }
  function edit(c: ContributionView, kind: Pillar3aContributionKind | null) {
    editing = c;
    preset = kind;
    dialogOpen = true;
  }
  function askDelete(c: ContributionView) {
    deleting = c;
    deleteOpen = true;
  }

  const deleteFields = $derived<Record<string, string>>(
    deleting?.source === "detected"
      ? { transactionId: deleting.transactionId ?? "" }
      : { contributionId: deleting?.id ?? "" },
  );
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Contributions</Card.Title>
    <Card.Description>
      Payments with a portfolio's reference are detected automatically. Add
      payments the app cannot see by hand.
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid gap-4">
    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if years.length > 1}
        <NativeSelect.Root
          bind:value={year}
          aria-label="Filter by year"
          class="w-28"
        >
          <NativeSelect.Option value="all">All years</NativeSelect.Option>
          {#each years as y (y)}
            <NativeSelect.Option value={String(y)}>{y}</NativeSelect.Option>
          {/each}
        </NativeSelect.Root>
      {/if}
      <Button
        size="sm"
        variant="outline"
        onclick={add}
        disabled={portfolios.length === 0}
      >
        <PlusIcon /> Add contribution
      </Button>
    </div>
    {#if portfolios.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><HandCoinsIcon /></Empty.Media>
          <Empty.Title>No portfolios yet</Empty.Title>
          <Empty.Description>
            Add a portfolio to a Pillar 3a account first. Contributions belong
            to a portfolio.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else if visible.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><HandCoinsIcon /></Empty.Media>
          <Empty.Title>No contributions</Empty.Title>
          <Empty.Description>
            Import payments that carry a portfolio's reference, or add a
            contribution by hand.
          </Empty.Description>
        </Empty.Header>
        <Empty.Content>
          <Button size="sm" onclick={add}>
            <PlusIcon /> Add contribution
          </Button>
        </Empty.Content>
      </Empty.Root>
    {:else}
      <ul class="divide-y">
        {#each visible as c (c.key)}
          <li
            class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3"
          >
            <div class="grid min-w-0 gap-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm">{prefs.date(c.date)}</span>
                <Badge
                  variant={c.source === "manual" ? "secondary" : "outline"}
                >
                  {c.source}
                </Badge>
                {#if c.kind === "buy_in"}
                  <Badge>
                    Buy-in{c.gapYears.length > 0
                      ? ` for ${c.gapYears.join(", ")}`
                      : ""}
                  </Badge>
                {/if}
              </div>
              <div class="text-muted-foreground text-sm break-words">
                {c.portfolioName}
                {#if c.dateOverridden && c.bookingDate}
                  · booked {prefs.date(c.bookingDate)}
                {/if}
              </div>
              {#if c.note}
                <div class="text-muted-foreground text-xs break-words">
                  {c.note}
                </div>
              {/if}
              {#if c.lateDecemberWarning}
                <p
                  class="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                >
                  <TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
                  {c.lateDecemberWarning}
                </p>
              {/if}
            </div>
            <div class="flex items-center gap-1">
              <Amount value={c.amount} {currency} class="font-medium" />
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button
                      {...props}
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Actions for the contribution of {prefs.date(
                        c.date,
                      )}"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-52">
                  <DropdownMenu.Item onSelect={() => edit(c, null)}>
                    <PencilIcon /> Edit
                  </DropdownMenu.Item>
                  {#if c.kind !== "buy_in"}
                    <DropdownMenu.Item onSelect={() => edit(c, "buy_in")}>
                      <ArrowDownToLineIcon /> Mark as buy-in
                    </DropdownMenu.Item>
                  {/if}
                  {#if c.source === "manual"}
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      variant="destructive"
                      onSelect={() => askDelete(c)}
                    >
                      <Trash2Icon /> Delete
                    </DropdownMenu.Item>
                  {:else if c.id !== null}
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => askDelete(c)}>
                      <RotateCcwIcon /> Reset to ordinary
                    </DropdownMenu.Item>
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Card.Content>
</Card.Root>

<ContributionDialog
  bind:open={dialogOpen}
  contribution={editing}
  presetKind={preset}
  {portfolios}
  {gaps}
/>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title={deleting?.source === "detected"
    ? "Reset this contribution?"
    : "Delete this contribution?"}
  description={deleting?.source === "detected"
    ? "The payment stays, but its type, credit date, gap years and note are reset to an ordinary contribution on the booking date."
    : "This contribution is removed and any gap years it closed are released."}
  action="?/deleteContribution"
  fields={deleteFields}
  confirmLabel={deleting?.source === "detected" ? "Reset" : "Delete"}
  successMessage={deleting?.source === "detected"
    ? "Contribution reset"
    : "Contribution deleted"}
/>
