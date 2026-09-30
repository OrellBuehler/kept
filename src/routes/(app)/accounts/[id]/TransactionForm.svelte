<script lang="ts">
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { minorToInput } from "$lib/amount-input";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { cn } from "$lib/utils";
  import type { PageData } from "./$types";

  type Tx = PageData["transactions"]["items"][number];

  let {
    action,
    currency,
    transaction = null,
    noteOnly = false,
    submitLabel,
    successMessage,
    onSuccess,
    onCancel,
  }: {
    action: string;
    currency: string;
    transaction?: Tx | null;
    /** Imported rows: only the note is editable. */
    noteOnly?: boolean;
    submitLabel: string;
    successMessage: string;
    onSuccess?: () => void;
    onCancel?: () => void;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  // svelte-ignore state_referenced_locally
  let direction = $state<"out" | "in">(
    transaction && transaction.amount > 0 ? "in" : "out",
  );
  // svelte-ignore state_referenced_locally
  let amountText = $state(
    transaction ? minorToInput(transaction.amount, currency) : "",
  );

  const signedAmount = $derived(
    amountText.trim() === ""
      ? ""
      : (direction === "out" ? "-" : "") + amountText.trim(),
  );

  function onAmountInput(e: Event & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value.trimStart();
    if (v.startsWith("-")) {
      direction = "out";
      amountText = v.slice(1);
      e.currentTarget.value = amountText;
    } else if (v.startsWith("+")) {
      direction = "in";
      amountText = v.slice(1);
      e.currentTarget.value = amountText;
    } else {
      amountText = v;
    }
  }
</script>

<form
  method="POST"
  {action}
  class="grid gap-4"
  use:enhance={submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => (errors = e),
    knownFields: noteOnly
      ? ["note"]
      : [
          "bookingDate",
          "valueDate",
          "amount",
          "counterpartyName",
          "counterpartyIban",
          "description",
          "reference",
          "note",
        ],
    successMessage,
    onSuccess: () => onSuccess?.(),
  })}
>
  {#if transaction}
    <input type="hidden" name="transactionId" value={transaction.id} />
  {/if}

  {#if !noteOnly}
    <div class="grid gap-4 sm:grid-cols-2">
      <FormField
        label="Booking date"
        for="{uid}-date"
        errors={errors.bookingDate}
      >
        <Input
          id="{uid}-date"
          name="bookingDate"
          type="date"
          required
          value={transaction?.bookingDate ?? todayIso()}
          aria-invalid={!!errors.bookingDate}
        />
      </FormField>
      <FormField
        label="Value date (optional)"
        for="{uid}-value-date"
        errors={errors.valueDate}
      >
        <Input
          id="{uid}-value-date"
          name="valueDate"
          type="date"
          value={transaction?.valueDate ?? ""}
          aria-invalid={!!errors.valueDate}
        />
      </FormField>
    </div>

    <FormField
      label="Amount ({currency})"
      for="{uid}-amount"
      errors={errors.amount}
    >
      <input type="hidden" name="amount" value={signedAmount} />
      <div class="flex gap-2">
        <div class="flex shrink-0" role="group" aria-label="Direction">
          <Button
            type="button"
            variant={direction === "out" ? "default" : "outline"}
            class="rounded-e-none"
            aria-pressed={direction === "out"}
            onclick={() => (direction = "out")}>Out</Button
          >
          <Button
            type="button"
            variant={direction === "in" ? "default" : "outline"}
            class={cn("rounded-s-none border-s-0")}
            aria-pressed={direction === "in"}
            onclick={() => (direction = "in")}>In</Button
          >
        </div>
        <Input
          id="{uid}-amount"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0.00"
          class="text-end tabular-nums"
          value={amountText}
          oninput={onAmountInput}
          aria-invalid={!!errors.amount}
        />
      </div>
    </FormField>

    <FormField
      label="Counterparty (optional)"
      for="{uid}-counterparty"
      errors={errors.counterpartyName}
    >
      <Input
        id="{uid}-counterparty"
        name="counterpartyName"
        maxlength={140}
        value={transaction?.counterpartyName ?? ""}
        aria-invalid={!!errors.counterpartyName}
      />
    </FormField>
    <FormField
      label="Counterparty IBAN (optional)"
      for="{uid}-cp-iban"
      errors={errors.counterpartyIban}
    >
      <Input
        id="{uid}-cp-iban"
        name="counterpartyIban"
        class="font-mono"
        autocomplete="off"
        value={transaction?.counterpartyIban ?? ""}
        aria-invalid={!!errors.counterpartyIban}
      />
    </FormField>
    <FormField
      label="Description (optional)"
      for="{uid}-description"
      errors={errors.description}
    >
      <Input
        id="{uid}-description"
        name="description"
        maxlength={500}
        value={transaction?.description ?? ""}
        aria-invalid={!!errors.description}
      />
    </FormField>
    <FormField
      label="Reference (optional)"
      for="{uid}-reference"
      errors={errors.reference}
    >
      <Input
        id="{uid}-reference"
        name="reference"
        class="font-mono"
        maxlength={35}
        value={transaction?.reference ?? ""}
        aria-invalid={!!errors.reference}
      />
    </FormField>
  {/if}

  <FormField label="Note (optional)" for="{uid}-note" errors={errors.note}>
    <Textarea
      id="{uid}-note"
      name="note"
      rows={3}
      maxlength={1000}
      value={transaction?.note ?? ""}
      aria-invalid={!!errors.note}
    />
  </FormField>

  {#if errors.form?.length}
    <p class="text-destructive text-sm" role="alert">{errors.form.join(" ")}</p>
  {/if}

  <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
    {#if onCancel}
      <Button
        type="button"
        variant="outline"
        onclick={onCancel}
        disabled={pending}>Cancel</Button
      >
    {/if}
    <Button type="submit" disabled={pending}>
      {#if pending}<Spinner />{/if}
      {submitLabel}
    </Button>
  </div>
</form>
