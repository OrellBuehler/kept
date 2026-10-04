<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { formatReference } from "$lib/references";
  import type { PortfolioView } from "$lib/server/pillar3a";

  let {
    open = $bindable(false),
    portfolio = null,
    qrIban = false,
  }: {
    open?: boolean;
    /** The portfolio being edited; null to add one. */
    portfolio?: PortfolioView | null;
    /** The deposit IBAN is a QR-IBAN, so the reference must be a QR reference. */
    qrIban?: boolean;
  } = $props();

  const uid = $props.id();
  const editing = $derived(portfolio !== null);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  $effect(() => {
    if (open) errors = {};
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit portfolio" : "Add portfolio"}</Dialog.Title
      >
      <Dialog.Description>
        Each portfolio is its own pension relationship with its own payment
        reference.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updatePortfolio" : "?/addPortfolio"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [
          "name",
          "number",
          "strategy",
          "depositReference",
          "openedOn",
          "sortOrder",
        ],
        successMessage: editing ? "Portfolio updated" : "Portfolio added",
        onSuccess: () => (open = false),
      })}
    >
      {#if portfolio}
        <input type="hidden" name="portfolioId" value={portfolio.id} />
      {/if}
      <FormField label="Name" for="{uid}-name" errors={errors.name}>
        <Input
          id="{uid}-name"
          name="name"
          required
          maxlength={80}
          placeholder="Portfolio 1"
          value={portfolio?.name ?? ""}
          aria-invalid={!!errors.name}
        />
      </FormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Strategy (optional)"
          for="{uid}-strategy"
          errors={errors.strategy}
        >
          <Input
            id="{uid}-strategy"
            name="strategy"
            maxlength={80}
            placeholder="Global 100"
            value={portfolio?.strategy ?? ""}
            aria-invalid={!!errors.strategy}
          />
        </FormField>
        <FormField
          label="Number (optional)"
          for="{uid}-number"
          errors={errors.number}
          hint="The provider's portfolio or relationship number."
        >
          <Input
            id="{uid}-number"
            name="number"
            class="font-mono"
            maxlength={60}
            autocomplete="off"
            value={portfolio?.number ?? ""}
            aria-invalid={!!errors.number}
          />
        </FormField>
      </div>
      <FormField
        label={qrIban
          ? "Payment reference (QR reference)"
          : "Payment reference (optional)"}
        for="{uid}-reference"
        errors={errors.depositReference}
        hint="Payments carrying this reference are detected as contributions. Spaces are fine."
      >
        <Input
          id="{uid}-reference"
          name="depositReference"
          class="font-mono"
          autocomplete="off"
          placeholder={qrIban ? "27 digits" : "27 digits or RF..."}
          value={portfolio?.depositReference
            ? formatReference(portfolio.depositReference)
            : ""}
          aria-invalid={!!errors.depositReference}
        />
      </FormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Opened on (optional)"
          for="{uid}-opened"
          errors={errors.openedOn}
        >
          <Input
            id="{uid}-opened"
            name="openedOn"
            type="date"
            value={portfolio?.openedOn ?? ""}
            aria-invalid={!!errors.openedOn}
          />
        </FormField>
        <FormField
          label="Sort order (optional)"
          for="{uid}-sort"
          errors={errors.sortOrder}
          hint="Lower numbers come first."
        >
          <Input
            id="{uid}-sort"
            name="sortOrder"
            inputmode="numeric"
            class="tabular-nums"
            autocomplete="off"
            value={portfolio && portfolio.sortOrder !== 0
              ? String(portfolio.sortOrder)
              : ""}
            aria-invalid={!!errors.sortOrder}
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
          {editing ? "Save" : "Add portfolio"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
