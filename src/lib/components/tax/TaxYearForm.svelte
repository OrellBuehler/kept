<script lang="ts">
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { minorToInput } from "$lib/amount-input";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { Minor } from "$lib/money";

  let {
    action,
    year = null,
    initialYear = null,
    authority = null,
    currency,
    assessedTotal = null,
    notes = null,
    submitLabel,
    successMessage,
  }: {
    action: string;
    /** Fixed when editing an existing year; editable when creating one. */
    year?: number | null;
    /** Suggested value for a new year. */
    initialYear?: number | null;
    authority?: string | null;
    currency: string;
    assessedTotal?: Minor | null;
    notes?: string | null;
    submitLabel: string;
    successMessage?: string;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
</script>

<form
  method="POST"
  {action}
  class="grid gap-4"
  use:enhance={submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => (errors = e),
    knownFields: ["year", "authority", "currency", "assessedTotal", "notes"],
    successMessage,
  })}
>
  <FormAlert message={formError(errors)} />
  <div class="grid gap-4 sm:grid-cols-2">
    {#if year === null}
      <FormField label="Tax year" for="{uid}-year" errors={errors.year}>
        <Input
          id="{uid}-year"
          name="year"
          inputmode="numeric"
          maxlength={4}
          required
          class="tabular-nums"
          placeholder="2025"
          value={initialYear ?? ""}
          aria-invalid={!!errors.year}
        />
      </FormField>
    {:else}
      <input type="hidden" name="year" value={year} />
    {/if}
    <FormField
      label="Tax authority"
      for="{uid}-authority"
      errors={errors.authority}
    >
      <Input
        id="{uid}-authority"
        name="authority"
        maxlength={140}
        placeholder="Name of the tax office"
        value={authority ?? ""}
        aria-invalid={!!errors.authority}
      />
    </FormField>
    <FormField label="Currency" for="{uid}-currency" errors={errors.currency}>
      <Input
        id="{uid}-currency"
        name="currency"
        maxlength={3}
        required
        class="font-mono uppercase"
        value={currency}
        aria-invalid={!!errors.currency}
      />
    </FormField>
    <FormField
      label="Assessed total (optional)"
      for="{uid}-assessed"
      errors={errors.assessedTotal}
      hint="What the final assessment says is owed for the year."
    >
      <Input
        id="{uid}-assessed"
        name="assessedTotal"
        inputmode="decimal"
        class="tabular-nums"
        placeholder="3000.00"
        value={assessedTotal === null
          ? ""
          : minorToInput(assessedTotal, currency)}
        aria-invalid={!!errors.assessedTotal}
      />
    </FormField>
  </div>
  <FormField label="Notes (optional)" for="{uid}-notes" errors={errors.notes}>
    <Textarea
      id="{uid}-notes"
      name="notes"
      rows={2}
      maxlength={2000}
      value={notes ?? ""}
      aria-invalid={!!errors.notes}
    />
  </FormField>
  <div>
    <Button type="submit" disabled={pending}>
      {#if pending}<Spinner />{/if}
      {submitLabel}
    </Button>
  </div>
</form>
