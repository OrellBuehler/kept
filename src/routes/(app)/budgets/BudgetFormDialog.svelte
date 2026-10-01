<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { categoryLabel, type CategoryOption } from "$lib/category-types";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { currencyExponent, toDecimalString, type Minor } from "$lib/money";

  interface Editable {
    budgetId: string;
    categoryId: string;
    budget: Minor;
  }

  let {
    open = $bindable(false),
    budget = null,
    currency = "",
    categories,
    currencies,
  }: {
    open?: boolean;
    budget?: Editable | null;
    /** The currency of the budget being edited. */
    currency?: string;
    categories: CategoryOption[];
    currencies: string[];
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let categoryId = $state("");

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      categoryId = budget?.categoryId ?? categories[0]?.id ?? "";
    });
  });

  const editing = $derived(budget !== null);
  const amountText = $derived(
    budget ? toDecimalString(budget.budget, currencyExponent(currency)) : "",
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit budget" : "Add budget"}</Dialog.Title>
      <Dialog.Description>
        A monthly spending limit for a category, in one currency. It includes
        the category's subcategories.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updateBudget" : "?/createBudget"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["categoryId", "currency", "amount"],
        successMessage: editing ? "Budget updated" : "Budget added",
        onSuccess: () => (open = false),
      })}
    >
      {#if budget}
        <input type="hidden" name="id" value={budget.budgetId} />
      {/if}
      <FormField
        label="Category"
        for="{uid}-category"
        errors={errors.categoryId}
      >
        <NativeSelect.Root
          id="{uid}-category"
          name="categoryId"
          class="w-full"
          required
          bind:value={categoryId}
        >
          {#each categories as c (c.id)}
            <NativeSelect.Option value={c.id}>
              {categoryLabel(c, categories)}
            </NativeSelect.Option>
          {/each}
        </NativeSelect.Root>
      </FormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Currency"
          for="{uid}-currency"
          errors={errors.currency}
        >
          <Input
            id="{uid}-currency"
            name="currency"
            required
            maxlength={3}
            list="{uid}-currencies"
            class="font-mono uppercase"
            placeholder="CHF"
            value={currency || currencies[0] || ""}
            aria-invalid={!!errors.currency}
          />
          <datalist id="{uid}-currencies">
            {#each currencies as c (c)}
              <option value={c}></option>
            {/each}
          </datalist>
        </FormField>
        <FormField
          label="Monthly amount"
          for="{uid}-amount"
          errors={errors.amount}
        >
          <Input
            id="{uid}-amount"
            name="amount"
            required
            inputmode="decimal"
            class="tabular-nums"
            placeholder="400.00"
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
          {editing ? "Save" : "Add budget"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
