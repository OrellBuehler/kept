<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button, buttonVariants } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import {
    ACCOUNT_TYPES,
    NOTICE_ACCOUNT_TYPES,
    WITHDRAWAL_PERIODS,
    type AccountType,
    type WithdrawalPeriod,
  } from "$lib/ledger-types";
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
    contractNumber?: string | null;
    depositIban?: string | null;
    openingBalance: Minor;
    openingDate: string | null;
    shareBps: number;
    sharedWith: string | null;
    noticeMonths: number | null;
    freeWithdrawal: Minor | null;
    freeWithdrawalPeriod: WithdrawalPeriod | null;
    fillFromTransfers?: boolean;
    tradesMoveCash?: boolean;
  }

  const prefs = usePreferences();

  let {
    open = $bindable(false),
    action,
    institutions,
    account = null,
    currencyLocked = false,
    defaultInstitutionId = "",
    mirrorCount = null,
    hasPortfolios = false,
    hasTrades = false,
  }: {
    open?: boolean;
    action: string;
    institutions: { id: string; name: string }[];
    account?: EditableAccount | null;
    /** The account already has data, so its currency can no longer change. */
    currencyLocked?: boolean;
    defaultInstitutionId?: string;
    /** Mirrored transactions on the account, for the confirm when filling is turned off; null when unknown. */
    mirrorCount?: number | null;
    /** Accounts with portfolios cannot be filled from transfers. */
    hasPortfolios?: boolean;
    /** Accounts with trades can make trades move cash whatever their type. */
    hasTrades?: boolean;
  } = $props();

  const uid = $props.id();
  const editing = $derived(account !== null);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let institutionId = $state("");
  let type = $state<AccountType>("current");
  let period = $state<WithdrawalPeriod | "">("");
  let fill = $state(false);
  let tradesCash = $state(false);
  let form = $state<HTMLFormElement | null>(null);
  let confirmOffOpen = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      institutionId = account
        ? (account.institution?.id ?? "")
        : defaultInstitutionId;
      type = account?.type ?? "current";
      period = account?.freeWithdrawalPeriod ?? "";
      fill = account?.fillFromTransfers ?? false;
      tradesCash = account?.tradesMoveCash ?? false;
      confirmOffOpen = false;
    });
  });

  const is3a = $derived(type === "pillar_3a");
  const hasNotice = $derived(NOTICE_ACCOUNT_TYPES.includes(type));

  const showFill = $derived(!is3a && !hasPortfolios);
  const showTradesCash = $derived(type === "investment" || hasTrades);
  const fillOn = $derived(showFill && fill);
  const tradesCashOn = $derived(showTradesCash && tradesCash);
  /** Saving would delete the account's mirrors. */
  const turningOff = $derived(
    editing &&
      account?.fillFromTransfers === true &&
      !fillOn &&
      mirrorCount !== 0,
  );

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
      bind:this={form}
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [
          "name",
          "type",
          "institutionId",
          "currency",
          "iban",
          "contractNumber",
          "depositIban",
          "openingBalance",
          "openingDate",
          "share",
          "sharedWith",
          "noticeMonths",
          "freeWithdrawal",
          "freeWithdrawalPeriod",
          "fillFromTransfers",
          "tradesMoveCash",
        ],
        successMessage: editing ? "Account updated" : "Account added",
        onSuccess: () => (open = false),
      })}
    >
      <input type="hidden" name="institutionId" value={institutionId} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="fillFromTransfersField" value="1" />
      {#if hasNotice}
        <input type="hidden" name="freeWithdrawalPeriod" value={period} />
      {/if}

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
            ? "Locked: this account already has transactions, balances, trades, portfolio values or an opening balance."
            : is3a
              ? "Pillar 3a accounts are held in CHF."
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

      {#if is3a}
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Contract number (optional)"
            for="{uid}-contract"
            errors={errors.contractNumber}
          >
            <Input
              id="{uid}-contract"
              name="contractNumber"
              class="font-mono"
              maxlength={60}
              autocomplete="off"
              value={account?.contractNumber ?? ""}
              aria-invalid={!!errors.contractNumber}
            />
          </FormField>
          <FormField
            label="Deposit IBAN (QR-IBAN)"
            for="{uid}-deposit-iban"
            errors={errors.depositIban}
            hint="The IBAN you pay contributions into. Spaces are fine."
          >
            <Input
              id="{uid}-deposit-iban"
              name="depositIban"
              class="font-mono"
              autocomplete="off"
              value={account?.depositIban ?? ""}
              aria-invalid={!!errors.depositIban}
            />
          </FormField>
        </div>
      {/if}

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

      {#if !is3a}
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
      {/if}

      {#if hasNotice}
        <div role="group" aria-labelledby="{uid}-withdrawal" class="grid gap-4">
          <p id="{uid}-withdrawal" class="text-sm font-medium">Withdrawal</p>
          <div class="grid gap-4 sm:grid-cols-3">
            <FormField
              label="Notice period (months)"
              for="{uid}-notice"
              errors={errors.noticeMonths}
              hint="Leave empty if you can withdraw at any time."
            >
              <Input
                id="{uid}-notice"
                name="noticeMonths"
                type="number"
                inputmode="numeric"
                min={1}
                max={60}
                step={1}
                autocomplete="off"
                class="tabular-nums"
                placeholder="6"
                value={account?.noticeMonths ?? ""}
                aria-invalid={!!errors.noticeMonths}
              />
            </FormField>
            <FormField
              label="Free withdrawal"
              for="{uid}-free"
              errors={errors.freeWithdrawal}
            >
              <Input
                id="{uid}-free"
                name="freeWithdrawal"
                inputmode="decimal"
                autocomplete="off"
                class="tabular-nums"
                placeholder="25000"
                value={account?.freeWithdrawal != null
                  ? minorToSignedInput(account.freeWithdrawal, account.currency)
                  : ""}
                aria-invalid={!!errors.freeWithdrawal}
              />
            </FormField>
            <FormField
              label="Per"
              for="{uid}-period"
              errors={errors.freeWithdrawalPeriod}
            >
              <Select.Root type="single" bind:value={period}>
                <Select.Trigger
                  id="{uid}-period"
                  aria-label="Free withdrawal period"
                  class="w-full"
                >
                  {period === ""
                    ? "None"
                    : period === "month"
                      ? "Month"
                      : "Year"}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="" label="None">None</Select.Item>
                  {#each WITHDRAWAL_PERIODS as p (p)}
                    <Select.Item
                      value={p}
                      label={p === "month" ? "Month" : "Year"}
                    >
                      {p === "month" ? "Month" : "Year"}
                    </Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </FormField>
          </div>
          <p class="text-muted-foreground -mt-2 text-xs">
            Amount you can withdraw per month/year without notice or fees. The
            rest is available once the notice period has passed. Counted from
            withdrawals this calendar month/year.
          </p>
        </div>
      {/if}

      {#if showFill || showTradesCash}
        <div role="group" aria-labelledby="{uid}-statements" class="grid gap-4">
          <p id="{uid}-statements" class="text-sm font-medium">Statements</p>
          {#if showFill}
            {#if fillOn}
              <input type="hidden" name="fillFromTransfers" value="on" />
            {/if}
            <div class="flex items-start gap-3">
              <Checkbox
                id="{uid}-fill"
                class="mt-0.5"
                bind:checked={fill}
                aria-describedby="{uid}-fill-hint"
              />
              <div class="grid gap-1">
                <Label for="{uid}-fill" class="leading-snug">
                  Fill from transfers in my other accounts
                </Label>
                <p id="{uid}-fill-hint" class="text-muted-foreground text-xs">
                  For accounts without statement exports. Kept creates the
                  counter-transaction when an imported account shows a transfer
                  to or from this IBAN.
                </p>
                {#if errors.fillFromTransfers?.length}
                  <p class="text-destructive text-sm" role="alert">
                    {errors.fillFromTransfers[0]}
                  </p>
                {/if}
              </div>
            </div>
          {/if}
          {#if showTradesCash}
            {#if tradesCashOn}
              <input type="hidden" name="tradesMoveCash" value="on" />
            {/if}
            <div class="flex items-start gap-3">
              <Checkbox
                id="{uid}-trades-cash"
                class="mt-0.5"
                bind:checked={tradesCash}
                aria-describedby="{uid}-trades-cash-hint"
              />
              <div class="grid gap-1">
                <Label for="{uid}-trades-cash" class="leading-snug">
                  Trades move cash
                </Label>
                <p
                  id="{uid}-trades-cash-hint"
                  class="text-muted-foreground text-xs"
                >
                  A buy lowers the cash balance and a sell raises it by the
                  trade amount. Use it when you have no broker statements, so
                  cash and holdings are not counted twice.
                </p>
                {#if errors.tradesMoveCash?.length}
                  <p class="text-destructive text-sm" role="alert">
                    {errors.tradesMoveCash[0]}
                  </p>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}

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
        <Button
          type={turningOff ? "button" : "submit"}
          disabled={pending}
          onclick={turningOff ? () => (confirmOffOpen = true) : undefined}
        >
          {#if pending}<Spinner />{/if}
          {editing ? "Save" : "Add account"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmOffOpen}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Stop filling this account?</AlertDialog.Title>
      <AlertDialog.Description>
        {#if mirrorCount === null}
          The transactions Kept created from transfers in your other accounts
          are deleted, and the balance is recalculated.
        {:else}
          The {mirrorCount === 1
            ? "transaction"
            : `${mirrorCount} transactions`} Kept created from transfers in your other
          accounts {mirrorCount === 1 ? "is" : "are"} deleted, and the balance is
          recalculated.
        {/if}
        Imported and manual transactions stay. Turn the setting on again to recreate
        them.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel type="button">Keep filling</AlertDialog.Cancel>
      <AlertDialog.Action
        class={buttonVariants({ variant: "destructive" })}
        onclick={() => {
          confirmOffOpen = false;
          form?.requestSubmit();
        }}
      >
        Delete mirrors and save
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
