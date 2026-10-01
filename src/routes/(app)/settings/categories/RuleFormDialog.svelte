<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import {
    categoryLabel,
    type AmountSign,
    type CategoryOption,
  } from "$lib/category-types";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";

  interface Editable {
    id: string;
    categoryId: string;
    priority: number;
    counterpartyContains: string | null;
    descriptionContains: string | null;
    counterpartyIban: string | null;
    amountSign: AmountSign | null;
  }

  let {
    open = $bindable(false),
    rule = null,
    categories,
  }: {
    open?: boolean;
    rule?: Editable | null;
    categories: CategoryOption[];
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let categoryId = $state("");
  let amountSign = $state("");

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      categoryId = rule?.categoryId ?? categories[0]?.id ?? "";
      amountSign = rule?.amountSign ?? "";
    });
  });

  const editing = $derived(rule !== null);
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit rule" : "Add rule"}</Dialog.Title>
      <Dialog.Description>
        A transaction gets the category when it matches every condition you set.
        Text matching ignores upper and lower case.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updateRule" : "?/createRule"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [
          "categoryId",
          "priority",
          "counterpartyContains",
          "descriptionContains",
          "counterpartyIban",
          "amountSign",
        ],
        successMessage: editing ? "Rule updated" : "Rule added",
        onSuccess: () => (open = false),
      })}
    >
      {#if rule}
        <input type="hidden" name="id" value={rule.id} />
      {/if}
      <FormField
        label="Counterparty contains"
        for="{uid}-counterparty"
        errors={errors.counterpartyContains}
      >
        <Input
          id="{uid}-counterparty"
          name="counterpartyContains"
          maxlength={100}
          placeholder="Example Grocer"
          value={rule?.counterpartyContains ?? ""}
          aria-invalid={!!errors.counterpartyContains}
        />
      </FormField>
      <FormField
        label="Description contains"
        for="{uid}-description"
        errors={errors.descriptionContains}
      >
        <Input
          id="{uid}-description"
          name="descriptionContains"
          maxlength={100}
          value={rule?.descriptionContains ?? ""}
          aria-invalid={!!errors.descriptionContains}
        />
      </FormField>
      <FormField
        label="Counterparty IBAN equals"
        for="{uid}-iban"
        errors={errors.counterpartyIban}
      >
        <Input
          id="{uid}-iban"
          name="counterpartyIban"
          maxlength={42}
          class="font-mono uppercase"
          value={rule?.counterpartyIban ?? ""}
          aria-invalid={!!errors.counterpartyIban}
        />
      </FormField>
      <FormField label="Direction" for="{uid}-sign" errors={errors.amountSign}>
        <NativeSelect.Root
          id="{uid}-sign"
          name="amountSign"
          class="w-full"
          bind:value={amountSign}
        >
          <NativeSelect.Option value="">Any</NativeSelect.Option>
          <NativeSelect.Option value="expense">
            Money out (expense)
          </NativeSelect.Option>
          <NativeSelect.Option value="income">
            Money in (income)
          </NativeSelect.Option>
        </NativeSelect.Root>
      </FormField>
      <div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
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
        <FormField
          label="Priority"
          for="{uid}-priority"
          errors={errors.priority}
          hint="Lower runs first."
        >
          <Input
            id="{uid}-priority"
            name="priority"
            inputmode="numeric"
            class="tabular-nums"
            value={String(rule?.priority ?? 100)}
            aria-invalid={!!errors.priority}
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
          {editing ? "Save" : "Add rule"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
