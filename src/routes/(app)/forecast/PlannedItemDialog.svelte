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

  interface Editable {
    id: string;
    label: string;
    date: string;
    amount: Minor;
    currency: string;
    accountId: string | null;
  }

  let {
    open = $bindable(false),
    item = null,
    today,
    accounts,
    currencies,
  }: {
    open?: boolean;
    item?: Editable | null;
    today: string;
    accounts: { id: string; name: string; currency: string }[];
    currencies: string[];
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let accountId = $state("");
  let direction = $state("expense");

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      accountId = item?.accountId ?? "";
      direction = item && item.amount > 0 ? "income" : "expense";
    });
  });

  const editing = $derived(item !== null);
  const amountText = $derived(
    item
      ? toDecimalString(
          Math.abs(item.amount) as Minor,
          currencyExponent(item.currency),
        )
      : "",
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>
        {editing ? "Edit planned item" : "Add planned item"}
      </Dialog.Title>
      <Dialog.Description>
        A one-off expected income or expense, such as a salary or a tax
        installment. It is added to the forecast on its date.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updatePlanned" : "?/createPlanned"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [
          "label",
          "date",
          "direction",
          "amount",
          "accountId",
          "currency",
        ],
        successMessage: editing ? "Planned item updated" : "Planned item added",
        onSuccess: () => (open = false),
      })}
    >
      {#if item}
        <input type="hidden" name="id" value={item.id} />
      {/if}
      <FormField label="Description" for="{uid}-label" errors={errors.label}>
        <Input
          id="{uid}-label"
          name="label"
          required
          maxlength={80}
          placeholder="Salary"
          value={item?.label ?? ""}
          aria-invalid={!!errors.label}
        />
      </FormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField label="Date" for="{uid}-date" errors={errors.date}>
          <Input
            id="{uid}-date"
            name="date"
            type="date"
            required
            value={item?.date ?? today}
            aria-invalid={!!errors.date}
          />
        </FormField>
        <FormField label="Type" for="{uid}-direction" errors={errors.direction}>
          <NativeSelect.Root
            id="{uid}-direction"
            name="direction"
            class="w-full"
            bind:value={direction}
          >
            <NativeSelect.Option value="expense">Expense</NativeSelect.Option>
            <NativeSelect.Option value="income">Income</NativeSelect.Option>
          </NativeSelect.Root>
        </FormField>
      </div>
      <FormField label="Account" for="{uid}-account" errors={errors.accountId}>
        <NativeSelect.Root
          id="{uid}-account"
          name="accountId"
          class="w-full"
          bind:value={accountId}
        >
          <NativeSelect.Option value="">No account</NativeSelect.Option>
          {#each accounts as a (a.id)}
            <NativeSelect.Option value={a.id}>
              {a.name} ({a.currency})
            </NativeSelect.Option>
          {/each}
        </NativeSelect.Root>
      </FormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField label="Amount" for="{uid}-amount" errors={errors.amount}>
          <Input
            id="{uid}-amount"
            name="amount"
            required
            inputmode="decimal"
            class="tabular-nums"
            placeholder="3000.00"
            value={amountText}
            aria-invalid={!!errors.amount}
          />
        </FormField>
        <FormField
          label="Currency"
          for="{uid}-currency"
          errors={errors.currency}
        >
          <Input
            id="{uid}-currency"
            name="currency"
            maxlength={3}
            list="{uid}-currencies"
            class="font-mono uppercase"
            placeholder="CHF"
            disabled={accountId !== ""}
            value={item?.currency ?? currencies[0] ?? ""}
            aria-invalid={!!errors.currency}
          />
          <datalist id="{uid}-currencies">
            {#each currencies as c (c)}
              <option value={c}></option>
            {/each}
          </datalist>
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
          {editing ? "Save" : "Add item"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
