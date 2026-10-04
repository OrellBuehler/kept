<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { minorToSignedInput } from "$lib/amount-input";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { PortfolioView } from "$lib/server/pillar3a";

  let {
    open = $bindable(false),
    portfolios,
    currency,
  }: {
    open?: boolean;
    /** The open portfolios of the account. */
    portfolios: PortfolioView[];
    currency: string;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  $effect(() => {
    if (open) errors = {};
  });

  const knownFields = $derived([
    "date",
    "note",
    ...portfolios.map((p) => `value:${p.id}`),
  ]);
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Update values</Dialog.Title>
      <Dialog.Description>
        Enter the current value of your portfolios as shown by your provider.
        Leave a portfolio blank to skip it.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/setPortfolioValues"
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields,
        successMessage: "Values saved",
        onSuccess: () => (open = false),
      })}
    >
      <FormField label="Date" for="{uid}-date" errors={errors.date}>
        <Input
          id="{uid}-date"
          name="date"
          type="date"
          required
          value={todayIso()}
          aria-invalid={!!errors.date}
        />
      </FormField>
      {#each portfolios as p (p.id)}
        <FormField
          label="{p.name}{p.strategy ? ` · ${p.strategy}` : ''} ({currency})"
          for="{uid}-{p.id}"
          errors={errors[`value:${p.id}`]}
        >
          <Input
            id="{uid}-{p.id}"
            name="value:{p.id}"
            inputmode="decimal"
            autocomplete="off"
            class="text-end tabular-nums"
            placeholder="0.00"
            value={p.latestValue !== null
              ? minorToSignedInput(p.latestValue, currency)
              : ""}
            aria-invalid={!!errors[`value:${p.id}`]}
          />
        </FormField>
      {/each}
      <FormField label="Note (optional)" for="{uid}-note" errors={errors.note}>
        <Input id="{uid}-note" name="note" maxlength={1000} />
      </FormField>
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
          Save values
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
