<script lang="ts">
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Select from "$lib/components/ui/select";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { COMMON_CURRENCIES } from "$lib/account-types";
  import {
    BILL_FIELDS,
    KIND_LABELS,
    REFERENCE_TYPE_LABELS,
    formatReference,
    type BillFormValues,
  } from "$lib/bill-display";
  import { BILL_KINDS, BILL_REFERENCE_TYPES } from "$lib/bill-types";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { formatIban } from "$lib/iban";

  let {
    action,
    values,
    accounts,
    documentId = null,
    submitLabel,
    successMessage,
    lockKindAndCurrency = false,
    onSuccess,
    onCancel,
  }: {
    action: string;
    values: BillFormValues;
    accounts: { id: string; name: string; currency: string }[];
    documentId?: string | null;
    submitLabel: string;
    successMessage?: string;
    /** The bill has payments, so its kind and currency can no longer change. */
    lockKindAndCurrency?: boolean;
    onSuccess?: () => void;
    onCancel?: () => void;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  // svelte-ignore state_referenced_locally
  let kind = $state(values.kind);
  // svelte-ignore state_referenced_locally
  let referenceType = $state(values.referenceType);
  // svelte-ignore state_referenced_locally
  let expectedAccountId = $state(values.expectedAccountId);
  // svelte-ignore state_referenced_locally
  let currency = $state(values.currency);

  const accountLabel = $derived(
    accounts.find((a) => a.id === expectedAccountId)?.name ?? "None",
  );

  function groupIban(e: FocusEvent & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value.trim();
    if (v) e.currentTarget.value = formatIban(v);
  }

  function groupReference(e: FocusEvent & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value.trim();
    if (v) e.currentTarget.value = formatReference(v);
  }
</script>

<form
  method="POST"
  {action}
  class="grid gap-4"
  use:enhance={submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => (errors = e),
    knownFields: BILL_FIELDS,
    successMessage,
    onSuccess: () => onSuccess?.(),
  })}
>
  {#if documentId}
    <input type="hidden" name="documentId" value={documentId} />
  {/if}
  <input type="hidden" name="kind" value={kind} />
  <input type="hidden" name="referenceType" value={referenceType} />
  <input type="hidden" name="expectedAccountId" value={expectedAccountId} />

  <div class="grid gap-4 sm:grid-cols-2">
    <FormField
      label="Type"
      for="{uid}-kind"
      errors={errors.kind}
      hint={lockKindAndCurrency
        ? "Locked: payments are already matched to this bill."
        : undefined}
    >
      <Select.Root
        type="single"
        bind:value={kind}
        disabled={lockKindAndCurrency}
      >
        <Select.Trigger id="{uid}-kind" aria-label="Type" class="w-full">
          {KIND_LABELS[kind]}
        </Select.Trigger>
        <Select.Content>
          {#each BILL_KINDS as k (k)}
            <Select.Item value={k} label={KIND_LABELS[k]}>
              {KIND_LABELS[k]}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </FormField>
    <FormField
      label="Invoice number (optional)"
      for="{uid}-number"
      errors={errors.invoiceNumber}
    >
      <Input
        id="{uid}-number"
        name="invoiceNumber"
        maxlength={100}
        autocomplete="off"
        value={values.invoiceNumber}
        aria-invalid={!!errors.invoiceNumber}
      />
    </FormField>
  </div>

  <FormField
    label="Creditor name"
    for="{uid}-creditor"
    errors={errors.creditorName}
  >
    <Input
      id="{uid}-creditor"
      name="creditorName"
      maxlength={140}
      autocomplete="off"
      value={values.creditorName}
      aria-invalid={!!errors.creditorName}
    />
  </FormField>
  <FormField
    label="Creditor IBAN (optional)"
    for="{uid}-iban"
    errors={errors.creditorIban}
  >
    <Input
      id="{uid}-iban"
      name="creditorIban"
      class="font-mono"
      autocomplete="off"
      spellcheck={false}
      value={values.creditorIban}
      onblur={groupIban}
      aria-invalid={!!errors.creditorIban}
    />
  </FormField>

  <div class="grid gap-4 sm:grid-cols-2">
    <FormField
      label="Amount (optional)"
      for="{uid}-amount"
      errors={errors.amount}
      hint="Leave empty for an open amount."
    >
      <Input
        id="{uid}-amount"
        name="amount"
        inputmode="decimal"
        autocomplete="off"
        placeholder="0.00"
        class="text-end tabular-nums"
        value={values.amount}
        aria-invalid={!!errors.amount}
      />
    </FormField>
    <FormField
      label="Currency"
      for="{uid}-currency"
      errors={errors.currency}
      hint={lockKindAndCurrency ? "Locked: payments are matched." : undefined}
    >
      {#if lockKindAndCurrency}
        <input type="hidden" name="currency" value={currency} />
      {/if}
      <Input
        id="{uid}-currency"
        name={lockKindAndCurrency ? undefined : "currency"}
        list="{uid}-currencies"
        required
        maxlength={3}
        minlength={3}
        autocapitalize="characters"
        autocomplete="off"
        class="font-mono uppercase"
        bind:value={currency}
        disabled={lockKindAndCurrency}
        aria-invalid={!!errors.currency}
      />
      <datalist id="{uid}-currencies">
        {#each COMMON_CURRENCIES as c (c)}
          <option value={c}></option>
        {/each}
      </datalist>
    </FormField>
  </div>

  <div class="grid gap-4 sm:grid-cols-2">
    <FormField
      label="Issue date (optional)"
      for="{uid}-issue"
      errors={errors.issueDate}
    >
      <Input
        id="{uid}-issue"
        name="issueDate"
        type="date"
        value={values.issueDate}
        aria-invalid={!!errors.issueDate}
      />
    </FormField>
    <FormField
      label="Due date (optional)"
      for="{uid}-due"
      errors={errors.dueDate}
    >
      <Input
        id="{uid}-due"
        name="dueDate"
        type="date"
        value={values.dueDate}
        aria-invalid={!!errors.dueDate}
      />
    </FormField>
  </div>

  <div class="grid gap-4 sm:grid-cols-[1fr_2fr]">
    <FormField
      label="Reference type"
      for="{uid}-reftype"
      errors={errors.referenceType}
    >
      <Select.Root type="single" bind:value={referenceType}>
        <Select.Trigger
          id="{uid}-reftype"
          aria-label="Reference type"
          class="w-full"
        >
          <span class="truncate">{REFERENCE_TYPE_LABELS[referenceType]}</span>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" label={REFERENCE_TYPE_LABELS[""]}>
            {REFERENCE_TYPE_LABELS[""]}
          </Select.Item>
          {#each BILL_REFERENCE_TYPES as t (t)}
            <Select.Item value={t} label={REFERENCE_TYPE_LABELS[t]}>
              {REFERENCE_TYPE_LABELS[t]}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
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
        autocomplete="off"
        spellcheck={false}
        maxlength={40}
        value={values.reference}
        onblur={groupReference}
        aria-invalid={!!errors.reference}
      />
    </FormField>
  </div>

  <FormField
    label="Message (optional)"
    for="{uid}-message"
    errors={errors.message}
  >
    <Input
      id="{uid}-message"
      name="message"
      maxlength={500}
      autocomplete="off"
      value={values.message}
      aria-invalid={!!errors.message}
    />
  </FormField>

  <div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
    <FormField
      label="Expected paying account (optional)"
      for="{uid}-account"
      errors={errors.expectedAccountId}
    >
      <Select.Root type="single" bind:value={expectedAccountId}>
        <Select.Trigger
          id="{uid}-account"
          aria-label="Expected paying account"
          class="w-full"
        >
          <span class="truncate">{accountLabel}</span>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" label="None">None</Select.Item>
          {#each accounts as a (a.id)}
            <Select.Item value={a.id} label={a.name}>
              {a.name} ({a.currency})
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </FormField>
    <FormField
      label="Tax year (optional)"
      for="{uid}-taxyear"
      errors={errors.taxYear}
    >
      <Input
        id="{uid}-taxyear"
        name="taxYear"
        inputmode="numeric"
        maxlength={4}
        autocomplete="off"
        class="tabular-nums"
        placeholder="YYYY"
        value={values.taxYear}
        aria-invalid={!!errors.taxYear}
      />
    </FormField>
  </div>

  <FormField label="Notes (optional)" for="{uid}-notes" errors={errors.notes}>
    <Textarea
      id="{uid}-notes"
      name="notes"
      rows={3}
      maxlength={2000}
      value={values.notes}
      aria-invalid={!!errors.notes}
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
