<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { ACCOUNT_TYPES, type AccountType } from "$lib/ledger-types";
  import { ACCOUNT_TYPE_LABELS, COMMON_CURRENCIES } from "$lib/account-types";
  import { minorToSignedInput } from "$lib/amount-input";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { shareToInput, type Minor } from "$lib/money";
  import { usePreferences } from "$lib/preferences.svelte";

  interface EditableAccount {
    institution: { id: string } | null;
    name: string;
    type: AccountType;
    currency: string;
    iban: string | null;
    openingBalance: Minor;
    openingDate: string | null;
    shareBps: number;
    sharedWith: string | null;
  }

  const prefs = usePreferences();

  let {
    open = $bindable(false),
    action,
    institutions,
    account = null,
    currencyLocked = false,
    defaultInstitutionId = "",
  }: {
    open?: boolean;
    action: string;
    institutions: { id: string; name: string }[];
    account?: EditableAccount | null;
    /** The account already has data, so its currency can no longer change. */
    currencyLocked?: boolean;
    defaultInstitutionId?: string;
  } = $props();

  const uid = $props.id();
  const editing = $derived(account !== null);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let institutionId = $state("");
  let type = $state<AccountType>("current");

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      institutionId = account
        ? (account.institution?.id ?? "")
        : defaultInstitutionId;
      type = account?.type ?? "current";
    });
  });

  const institutionLabel = $derived(
    institutions.find((i) => i.id === institutionId)?.name ?? "None",
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit account" : "Add account"}</Dialog.Title>
      <Dialog.Description>
        {editing
          ? "Change how this account is described."
          : "Add the account first, then import statements into it."}
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      {action}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [
          "name",
          "type",
          "institutionId",
          "currency",
          "iban",
          "openingBalance",
          "openingDate",
          "share",
          "sharedWith",
        ],
        successMessage: editing ? "Account updated" : "Account added",
        onSuccess: () => (open = false),
      })}
    >
      <input type="hidden" name="institutionId" value={institutionId} />
      <input type="hidden" name="type" value={type} />

      <FormField label="Name" for="{uid}-name" errors={errors.name}>
        <Input
          id="{uid}-name"
          name="name"
          required
          maxlength={80}
          placeholder="Everyday account"
          value={account?.name ?? ""}
          aria-invalid={!!errors.name}
        />
      </FormField>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Institution"
          for="{uid}-institution"
          errors={errors.institutionId}
        >
          <Select.Root type="single" bind:value={institutionId}>
            <Select.Trigger
              id="{uid}-institution"
              aria-label="Institution"
              class="data-[placeholder]:text-foreground w-full"
            >
              <span class="truncate">{institutionLabel}</span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="" label="None">None</Select.Item>
              {#each institutions as inst (inst.id)}
                <Select.Item value={inst.id} label={inst.name}>
                  {inst.name}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </FormField>
        <FormField label="Type" for="{uid}-type" errors={errors.type}>
          <Select.Root type="single" bind:value={type}>
            <Select.Trigger id="{uid}-type" aria-label="Type" class="w-full">
              {ACCOUNT_TYPE_LABELS[type]}
            </Select.Trigger>
            <Select.Content>
              {#each ACCOUNT_TYPES as t (t)}
                <Select.Item value={t} label={ACCOUNT_TYPE_LABELS[t]}>
                  {ACCOUNT_TYPE_LABELS[t]}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </FormField>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Currency"
          for="{uid}-currency"
          errors={errors.currency}
          hint={currencyLocked
            ? "Locked: this account already has transactions or balances."
            : "3-letter ISO code, e.g. CHF."}
        >
          {#if currencyLocked}
            <input type="hidden" name="currency" value={account?.currency} />
          {/if}
          <Input
            id="{uid}-currency"
            name={currencyLocked ? undefined : "currency"}
            list="{uid}-currencies"
            required
            maxlength={3}
            minlength={3}
            autocapitalize="characters"
            autocomplete="off"
            class="font-mono uppercase"
            value={account?.currency ?? prefs.defaultCurrency}
            disabled={currencyLocked}
            aria-invalid={!!errors.currency}
          />
          <datalist id="{uid}-currencies">
            {#each COMMON_CURRENCIES as c (c)}
              <option value={c}></option>
            {/each}
          </datalist>
        </FormField>
        <FormField
          label="IBAN (optional)"
          for="{uid}-iban"
          errors={errors.iban}
        >
          <Input
            id="{uid}-iban"
            name="iban"
            class="font-mono"
            autocomplete="off"
            placeholder="Spaces are fine"
            value={account?.iban ?? ""}
            aria-invalid={!!errors.iban}
          />
        </FormField>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Opening balance"
          for="{uid}-opening-balance"
          errors={errors.openingBalance}
          hint="Negative for debt, e.g. -120.50."
        >
          <Input
            id="{uid}-opening-balance"
            name="openingBalance"
            inputmode="decimal"
            autocomplete="off"
            class="tabular-nums"
            placeholder="0.00"
            value={account && account.openingBalance !== 0
              ? minorToSignedInput(account.openingBalance, account.currency)
              : ""}
            aria-invalid={!!errors.openingBalance}
          />
        </FormField>
        <FormField
          label="Opening date"
          for="{uid}-opening-date"
          errors={errors.openingDate}
          hint="Balance applies from this day."
        >
          <Input
            id="{uid}-opening-date"
            name="openingDate"
            type="date"
            value={account?.openingDate ?? ""}
            aria-invalid={!!errors.openingDate}
          />
        </FormField>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="My share (%)"
          for="{uid}-share"
          errors={errors.share}
          hint="Your ownership share if you co-own this account, e.g. 50 or 33.33. Leave at 100 otherwise. Imported amounts stay at 100%."
        >
          <Input
            id="{uid}-share"
            name="share"
            inputmode="decimal"
            autocomplete="off"
            class="tabular-nums"
            placeholder="100"
            value={account ? shareToInput(account.shareBps) : "100"}
            aria-invalid={!!errors.share}
          />
        </FormField>
        <FormField
          label="Shared with (optional)"
          for="{uid}-shared-with"
          errors={errors.sharedWith}
          hint="A label only, e.g. a first name."
        >
          <Input
            id="{uid}-shared-with"
            name="sharedWith"
            maxlength={80}
            autocomplete="off"
            value={account?.sharedWith ?? ""}
            aria-invalid={!!errors.sharedWith}
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
          {editing ? "Save" : "Add account"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
