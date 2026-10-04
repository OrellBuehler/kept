<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import UndoIcon from "@lucide/svelte/icons/undo-2";
  import XIcon from "@lucide/svelte/icons/x";
  import Amount from "$lib/components/Amount.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { submitHandler } from "$lib/form-submit";
  import { formatDate } from "$lib/format";
  import { DEDUCTION_LABELS, DEDUCTION_TYPES } from "$lib/tax-deductions";
  import type {
    DeductionMappingView,
    DeductionSummary,
  } from "$lib/server/tax/deductions";

  let {
    summary,
    mappings,
  }: { summary: DeductionSummary; mappings: DeductionMappingView[] } = $props();

  let error = $state("");
  const action = submitHandler({
    setPending: () => {},
    setErrors: (e) => (error = e.form?.[0] ?? ""),
    knownFields: [],
  });

  const reportHref = $derived(
    `${resolve("/reports/tax-deductions")}?year=${encodeURIComponent(String(summary.year))}`,
  );
</script>

<div class="grid gap-6">
  <FormAlert message={error || undefined} />

  <Card.Root>
    <Card.Header>
      <Card.Title>Deductions {summary.year}</Card.Title>
      <Card.Description>
        Spending in your mapped categories, per deduction type and currency.
        Refunds reduce the total. A transaction counts for its tax year when it
        has one, otherwise for the year of its booking date.
      </Card.Description>
      <Card.Action>
        <Button
          variant="outline"
          href={reportHref}
          data-sveltekit-reload
          download
        >
          <DownloadIcon /> PDF report
        </Button>
      </Card.Action>
    </Card.Header>
    <Card.Content class="grid gap-4">
      {#if summary.totals.length === 0}
        <Empty.Root class="border border-dashed">
          <Empty.Header>
            <Empty.Title>No deductions for {summary.year}</Empty.Title>
            <Empty.Description>
              Map your categories to deduction types below.
            </Empty.Description>
          </Empty.Header>
        </Empty.Root>
      {:else}
        {#each summary.totals as group (group.type + group.currency)}
          <section class="grid gap-2 rounded-md border p-3">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-medium">
                {DEDUCTION_LABELS[group.type]}
                <span class="text-muted-foreground text-sm">
                  ({group.currency})
                </span>
              </h3>
              <Amount
                value={group.total}
                currency={group.currency}
                class="font-medium"
              />
            </div>
            <ul class="grid gap-1">
              {#each group.lines as line (line.transactionId)}
                <li class="flex items-center justify-between gap-2 text-sm">
                  <span class="min-w-0 truncate">
                    {formatDate(line.date)}
                    {#if line.label}· {line.label}{/if}
                    {#if line.explicitYear}
                      <span class="text-muted-foreground text-xs">
                        · tax year set
                      </span>
                    {/if}
                  </span>
                  <span class="flex items-center gap-1">
                    <Amount value={line.amount} currency={line.currency} />
                    <form
                      method="POST"
                      action="?/excludeDeduction"
                      use:enhance={action}
                    >
                      <input
                        type="hidden"
                        name="transactionId"
                        value={line.transactionId}
                      />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon"
                        class="size-7"
                        aria-label="Exclude this transaction from the deductions"
                      >
                        <XIcon />
                      </Button>
                    </form>
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}

      {#if summary.excluded.length > 0}
        <section class="grid gap-2">
          <h3 class="text-muted-foreground text-sm font-medium">Excluded</h3>
          <ul class="grid gap-1">
            {#each summary.excluded as line (line.transactionId)}
              <li
                class="text-muted-foreground flex items-center justify-between gap-2 text-sm"
              >
                <span class="min-w-0 truncate">
                  {formatDate(line.date)}
                  {#if line.label}· {line.label}{/if}
                  · {DEDUCTION_LABELS[line.type]}
                </span>
                <span class="flex items-center gap-1">
                  <Amount value={line.amount} currency={line.currency} />
                  <form
                    method="POST"
                    action="?/includeDeduction"
                    use:enhance={action}
                  >
                    <input
                      type="hidden"
                      name="transactionId"
                      value={line.transactionId}
                    />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="icon"
                      class="size-7"
                      aria-label="Include this transaction in the deductions again"
                    >
                      <UndoIcon />
                    </Button>
                  </form>
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Category mapping</Card.Title>
      <Card.Description>
        Choose which deduction type each of your categories belongs to.
        Subcategories use their parent's type unless you set their own.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if mappings.length === 0}
        <Empty.Root class="border border-dashed">
          <Empty.Header>
            <Empty.Title>No categories yet</Empty.Title>
            <Empty.Description>
              <a
                class="underline underline-offset-2"
                href={resolve("/(app)/settings/categories")}
                >Create categories</a
              > to map them to deduction types.
            </Empty.Description>
          </Empty.Header>
        </Empty.Root>
      {:else}
        <ul class="grid gap-2">
          {#each mappings as m (m.categoryId)}
            <li
              class="flex flex-wrap items-center justify-between gap-2 {m.parentId
                ? 'pl-6'
                : ''}"
            >
              <span class="text-sm">{m.name}</span>
              <form
                method="POST"
                action="?/setDeduction"
                use:enhance={action}
                onchange={(e) => e.currentTarget.requestSubmit()}
              >
                <input type="hidden" name="categoryId" value={m.categoryId} />
                <NativeSelect.Root
                  name="deductionType"
                  value={m.own ?? ""}
                  aria-label="Deduction type for {m.name}"
                >
                  <NativeSelect.Option value="">
                    {m.inherited && m.effective
                      ? `Inherited: ${DEDUCTION_LABELS[m.effective]}`
                      : "Not a deduction"}
                  </NativeSelect.Option>
                  {#each DEDUCTION_TYPES as type (type)}
                    <NativeSelect.Option value={type}>
                      {DEDUCTION_LABELS[type]}
                    </NativeSelect.Option>
                  {/each}
                </NativeSelect.Root>
              </form>
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
