<script lang="ts">
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";

  let {
    transactionId,
    deductionYear,
  }: { transactionId: string; deductionYear: number | null } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
</script>

<form
  method="POST"
  action="?/setDeductionYear"
  class="grid gap-2 rounded-md border p-3"
  use:enhance={submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => (errors = e),
    knownFields: ["deductionYear"],
    successMessage: "Deduction year updated",
  })}
>
  <input type="hidden" name="transactionId" value={transactionId} />
  <FormField
    label="Deduct in year"
    for="{uid}-year"
    errors={errors.deductionYear ?? errors.form}
    hint="Counts this transaction in the tax deductions of that year instead of its booking year. Leave empty to use the booking year. This is not a tax payment."
  >
    <div class="flex gap-2">
      <Input
        id="{uid}-year"
        name="deductionYear"
        inputmode="numeric"
        maxlength={4}
        placeholder="2025"
        class="w-28 tabular-nums"
        value={deductionYear ?? ""}
        aria-invalid={!!errors.deductionYear}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {#if pending}<Spinner />{/if}
        Save
      </Button>
    </div>
  </FormField>
</form>
