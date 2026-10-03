<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { currencyExponent, toDecimalString, type Minor } from "$lib/money";
  import { CADENCES, CADENCE_LABELS, type Cadence } from "$lib/recurring-types";

  interface Editable {
    id: string;
    name: string;
    cadence: Cadence;
    amount: Minor;
    currency: string;
  }

  let {
    open = $bindable(false),
    series,
  }: { open?: boolean; series: Editable | null } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let cadence = $state<Cadence>("monthly");

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      cadence = series?.cadence ?? "monthly";
    });
  });

  const amountText = $derived(
    series
      ? toDecimalString(
          Math.abs(series.amount) as Minor,
          currencyExponent(series.currency),
        )
      : "",
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Edit recurring payment</Dialog.Title>
      <Dialog.Description>
        Your changes are kept when the transactions are scanned again.
      </Dialog.Description>
    </Dialog.Header>
    {#if series}
      <form
        method="POST"
        action="?/edit"
        class="grid gap-4"
        use:enhance={submitHandler({
          setPending: (v) => (pending = v),
          setErrors: (e) => (errors = e),
          knownFields: ["name", "cadence", "amount"],
          successMessage: "Recurring payment updated",
          onSuccess: () => (open = false),
        })}
      >
        <input type="hidden" name="id" value={series.id} />
        <FormField label="Name" for="{uid}-name" errors={errors.name}>
          <Input
            id="{uid}-name"
            name="name"
            required
            maxlength={100}
            value={series.name}
            aria-invalid={!!errors.name}
          />
        </FormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Repeats"
            for="{uid}-cadence"
            errors={errors.cadence}
          >
            <NativeSelect.Root
              id="{uid}-cadence"
              name="cadence"
              class="w-full"
              bind:value={cadence}
            >
              {#each CADENCES as c (c)}
                <NativeSelect.Option value={c}>
                  {CADENCE_LABELS[c]}
                </NativeSelect.Option>
              {/each}
            </NativeSelect.Root>
          </FormField>
          <FormField
            label="Amount ({series.currency})"
            for="{uid}-amount"
            errors={errors.amount}
          >
            <Input
              id="{uid}-amount"
              name="amount"
              required
              inputmode="decimal"
              class="tabular-nums"
              value={amountText}
              aria-invalid={!!errors.amount}
            />
          </FormField>
        </div>
        {#if errors.form?.length}
          <p class="text-destructive text-sm" role="alert">
            {errors.form.join(" ")}
          </p>
        {/if}
        <Dialog.Footer>
          <Button
            type="button"
            variant="outline"
            onclick={() => (open = false)}
            disabled={pending}>Cancel</Button
          >
          <Button type="submit" disabled={pending}>
            {#if pending}<Spinner />{/if}
            Save
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
