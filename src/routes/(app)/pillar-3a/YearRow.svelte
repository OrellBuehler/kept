<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Progress } from "$lib/components/ui/progress";
  import { Spinner } from "$lib/components/ui/spinner";
  import Amount from "$lib/components/Amount.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { minorToInput } from "$lib/amount-input";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
  import {
    PILLAR_3A_DEDUCTIONS,
    PILLAR_3A_DEDUCTION_LABELS,
    type Pillar3aDeduction,
  } from "$lib/pillar-3a-types";
  import type { Pillar3aYearOverview } from "$lib/server/pillar3a";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  let {
    row,
    thisYear,
  }: {
    row: Pillar3aYearOverview;
    thisYear: number;
  } = $props();

  const uid = $props.id();
  const currency = PILLAR_3A_CURRENCY;
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  // svelte-ignore state_referenced_locally
  let deduction = $state<Pillar3aDeduction>(row.deduction);

  $effect(() => {
    const next = row.deduction;
    untrack(() => (deduction = next));
  });

  const isPast = $derived(row.year < thisYear);
  const percent = $derived(
    row.limit > 0 ? Math.min(100, (row.ordinary / row.limit) * 100) : 0,
  );
  const limitHint = $derived(
    row.deduction === "large" && row.earnedIncome === null
      ? "Enter your net earned income for the exact limit."
      : "Estimate: this year's limit is not published yet.",
  );
</script>

<li class="grid gap-3 py-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-lg font-semibold tabular-nums">{row.year}</h3>
    <div class="flex flex-wrap items-center gap-2">
      {#if row.closedBy}
        <Badge
          variant="outline"
          class="border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
        >
          <CircleCheckIcon /> Closed by buy-in
        </Badge>
      {:else if row.buyInEligible}
        <Badge variant="outline">Open gap</Badge>
      {/if}
      {#if row.overLimit > 0}
        <Badge variant="outline" class="border-destructive/40 text-destructive">
          <TriangleAlertIcon /> Over the limit
        </Badge>
      {/if}
    </div>
  </div>

  <div class="grid gap-1.5">
    <Progress
      value={percent}
      max={100}
      aria-label="Ordinary contributions of {row.year} against the limit"
    />
    <div
      class="text-muted-foreground flex flex-wrap justify-between gap-x-3 text-xs"
    >
      <span>
        Paid <Amount value={row.ordinary} {currency} /> of
        <Amount value={row.limit} {currency} />
      </span>
      {#if row.limitUnconfirmed}
        <span>{limitHint}</span>
      {/if}
    </div>
  </div>

  <dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
    <div class="min-w-0">
      <dt class="text-muted-foreground text-xs">Ordinary</dt>
      <dd class="text-start">
        <Amount value={row.ordinary} {currency} />
      </dd>
    </div>
    <div class="min-w-0">
      <dt class="text-muted-foreground text-xs">Buy-in</dt>
      <dd class="text-start">
        <Amount value={row.buyIn} {currency} />
      </dd>
    </div>
    <div class="min-w-0">
      <dt class="text-muted-foreground text-xs">
        {isPast ? "Gap" : "Room left"}
      </dt>
      <dd class="text-start">
        {#if row.closedBy}
          <span class="text-muted-foreground">Closed</span>
        {:else}
          <Amount value={row.gap} {currency} />
        {/if}
      </dd>
    </div>
  </dl>

  {#if row.overLimit > 0}
    <p class="text-destructive text-sm" role="alert">
      Ordinary contributions exceed the limit by
      <Amount value={row.overLimit} {currency} />. The excess is not deductible.
    </p>
  {/if}

  <form
    method="POST"
    action="?/setYear"
    class="flex flex-wrap items-end gap-3"
    use:enhance={submitHandler({
      setPending: (v) => (pending = v),
      setErrors: (e) => (errors = e),
      knownFields: ["deduction", "earnedIncome"],
      successMessage: `Deduction for ${row.year} saved`,
    })}
  >
    <input type="hidden" name="year" value={row.year} />
    <FormField
      label="Deduction"
      for="{uid}-deduction"
      errors={errors.deduction}
      class="min-w-0 flex-1 basis-56"
    >
      <NativeSelect.Root
        id="{uid}-deduction"
        name="deduction"
        bind:value={deduction}
        class="w-full"
      >
        {#each PILLAR_3A_DEDUCTIONS as d (d)}
          <NativeSelect.Option value={d}>
            {PILLAR_3A_DEDUCTION_LABELS[d]}
          </NativeSelect.Option>
        {/each}
      </NativeSelect.Root>
    </FormField>
    {#if deduction === "large"}
      <FormField
        label="Net earned income ({currency})"
        for="{uid}-income"
        errors={errors.earnedIncome}
        class="basis-40"
      >
        <Input
          id="{uid}-income"
          name="earnedIncome"
          inputmode="decimal"
          autocomplete="off"
          class="text-end tabular-nums"
          placeholder="0.00"
          value={row.earnedIncome !== null
            ? minorToInput(row.earnedIncome, currency)
            : ""}
          aria-invalid={!!errors.earnedIncome}
        />
      </FormField>
    {/if}
    <Button type="submit" variant="outline" disabled={pending}>
      {#if pending}<Spinner />{/if}
      Save
    </Button>
    {#if errors.form?.length}
      <p class="text-destructive basis-full text-sm" role="alert">
        {errors.form.join(" ")}
      </p>
    {/if}
    {#if row.settingInherited && !pending}
      <p class="text-muted-foreground basis-full text-xs">
        Carried over from the previous year until you save.
      </p>
    {/if}
  </form>
</li>
