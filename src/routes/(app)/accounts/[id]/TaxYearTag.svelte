<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";

  let {
    transactionId,
    taxYear,
  }: { transactionId: string; taxYear: number | null } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
</script>

<form
  method="POST"
  action="?/setTaxYear"
  class="grid gap-2 rounded-md border p-3"
  use:enhance={submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => (errors = e),
    knownFields: ["taxYear"],
    successMessage: "Tax payment updated",
  })}
>
  <input type="hidden" name="transactionId" value={transactionId} />
  <FormField
    label="Tax payment for year"
    for="{uid}-year"
    errors={errors.taxYear ?? errors.form}
    hint="Counts this transaction as paid to the tax office. Leave empty if it is not a tax payment."
  >
    <div class="flex gap-2">
      <Input
        id="{uid}-year"
        name="taxYear"
        inputmode="numeric"
        maxlength={4}
        placeholder="2025"
        class="w-28 tabular-nums"
        value={taxYear ?? ""}
        aria-invalid={!!errors.taxYear}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {#if pending}<Spinner />{/if}
        Save
      </Button>
    </div>
  </FormField>
  {#if taxYear !== null}
    <a
      class="text-muted-foreground text-xs underline-offset-4 hover:underline"
      href={resolve("/(app)/taxes/[year]", { year: String(taxYear) })}
    >
      Open tax {taxYear}
    </a>
  {/if}
</form>
