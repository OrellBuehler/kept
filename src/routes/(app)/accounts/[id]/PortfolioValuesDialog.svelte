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
  import type { PortfolioValueView, PortfolioView } from "$lib/server/pillar3a";

  let {
    open = $bindable(false),
    portfolios,
    values,
    currency,
  }: {
    open?: boolean;
    /** The open portfolios of the account. */
    portfolios: PortfolioView[];
    /** Value history per portfolio id. */
    values: Record<string, PortfolioValueView[]>;
    currency: string;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  let date = $state(todayIso());

  $effect(() => {
    if (open) {
      errors = {};
      date = todayIso();
    }
  });

  // What the chosen date already holds: saving a blank gain or return clears it.
  const stored = (portfolioId: string) =>
    values[portfolioId]?.find((v) => v.date === date);

  const knownFields = $derived([
    "date",
    "note",
    ...portfolios.flatMap((p) => [
      `value:${p.id}`,
      `gain:${p.id}`,
      `gainPercent:${p.id}`,
    ]),
  ]);
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Update values</Dialog.Title>
      <Dialog.Description>
        Enter the current value of your portfolios as shown by your provider,
        and its total gain if you want to follow the performance. Leave a
        portfolio blank to skip it.
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
          bind:value={date}
          aria-invalid={!!errors.date}
        />
      </FormField>
      {#each portfolios as p (p.id)}
        <fieldset class="grid gap-2">
          <legend class="mb-2 text-sm font-medium break-words">
            {p.name}{p.strategy ? ` · ${p.strategy}` : ""}
          </legend>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <FormField
              label="Value ({currency})"
              for="{uid}-{p.id}"
              errors={errors[`value:${p.id}`]}
              class="col-span-2 sm:col-span-1"
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
            <FormField
              label="Gain ({currency})"
              for="{uid}-{p.id}-gain"
              errors={errors[`gain:${p.id}`]}
            >
              <Input
                id="{uid}-{p.id}-gain"
                name="gain:{p.id}"
                inputmode="text"
                autocomplete="off"
                class="text-end tabular-nums"
                placeholder="optional"
                value={stored(p.id)?.gain != null
                  ? minorToSignedInput(stored(p.id)!.gain!, currency)
                  : ""}
                aria-invalid={!!errors[`gain:${p.id}`]}
              />
            </FormField>
            <FormField
              label="Return (%)"
              for="{uid}-{p.id}-percent"
              errors={errors[`gainPercent:${p.id}`]}
            >
              <Input
                id="{uid}-{p.id}-percent"
                name="gainPercent:{p.id}"
                inputmode="text"
                autocomplete="off"
                class="text-end tabular-nums"
                placeholder="optional"
                value={stored(p.id)?.gainBps != null
                  ? minorToSignedInput(stored(p.id)!.gainBps!, currency)
                  : ""}
                aria-invalid={!!errors[`gainPercent:${p.id}`]}
              />
            </FormField>
          </div>
        </fieldset>
      {/each}
      <p class="text-muted-foreground text-xs">
        Gain and return are the totals since the portfolio was opened, negative
        for a loss. With only the gain, the return is worked out from it.
      </p>
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
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />{/if}
          Save values
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
