<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { currencyExponent, toDecimalString, type Minor } from "$lib/money";

  let {
    open = $bindable(false),
    account,
    threshold = null,
    defaultPayment = false,
  }: {
    open?: boolean;
    account: { id: string; name: string; currency: string } | null;
    threshold?: Minor | null;
    defaultPayment?: boolean;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
    });
  });

  const thresholdText = $derived(
    threshold !== null && account
      ? toDecimalString(threshold, currencyExponent(account.currency))
      : "",
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Forecast settings for {account?.name ?? ""}</Dialog.Title>
      <Dialog.Description>
        Choose when to warn about a low balance and whether bills without a
        paying account are projected on this account.
      </Dialog.Description>
    </Dialog.Header>
    {#if account}
      <form
        method="POST"
        action="?/saveSettings"
        class="grid gap-4"
        use:enhance={submitHandler({
          setPending: (v) => (pending = v),
          setErrors: (e) => (errors = e),
          knownFields: ["threshold", "defaultPayment"],
          successMessage: "Settings saved",
          onSuccess: () => (open = false),
        })}
      >
        <input type="hidden" name="accountId" value={account.id} />
        <FormField
          label="Warn below ({account.currency})"
          for="{uid}-threshold"
          errors={errors.threshold}
        >
          <Input
            id="{uid}-threshold"
            name="threshold"
            inputmode="decimal"
            class="tabular-nums"
            placeholder="0.00"
            value={thresholdText}
            aria-invalid={!!errors.threshold}
          />
        </FormField>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="defaultPayment"
            class="mt-0.5 size-4"
            checked={defaultPayment}
          />
          <span>
            Default payment account for {account.currency}. Bills and planned
            items without an account are projected here.
          </span>
        </label>
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
