<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { minorToInput } from "$lib/amount-input";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { TRADE_SIDE_LABELS } from "$lib/investment-labels";
  import { TRADE_SIDES, type TradeSide } from "$lib/investment-types";
  import { currencyExponent, parseAmount } from "$lib/money";
  import { fixed, fixedToInput, parseFixed, valueOf } from "$lib/quantity";
  import type { PageData } from "./$types";

  type Trade = PageData["trades"][number];

  let {
    open = $bindable(false),
    action,
    currency,
    securities,
    trade = null,
  }: {
    open?: boolean;
    action: string;
    /** Account currency. */
    currency: string;
    securities: PageData["securities"];
    trade?: Trade | null;
  } = $props();

  const uid = $props.id();
  const editing = $derived(trade !== null);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let securityId = $state("");
  let side = $state<TradeSide>("buy");
  let quantity = $state("");
  let price = $state("");
  let fees = $state("");
  let amount = $state("");
  let amountTouched = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      securityId = trade?.securityId ?? securities[0]?.id ?? "";
      side = trade?.side ?? "buy";
      quantity = trade ? fixedToInput(trade.quantity) : "";
      price = trade ? fixedToInput(trade.price) : "";
      fees =
        trade && trade.fees !== 0 ? minorToInput(trade.fees, currency) : "";
      amount = trade ? minorToInput(trade.amount, currency) : "";
      amountTouched = trade !== null;
    });
  });

  const isSplit = $derived(side === "split");
  const security = $derived(securities.find((s) => s.id === securityId));
  const sameCurrency = $derived(security?.currency === currency);

  // Convenience only: the server takes the amount as entered and is the
  // source of truth. Only offered when no exchange rate is involved.
  const suggested = $derived.by(() => {
    if (!sameCurrency) return null;
    try {
      const gross = valueOf(
        parseFixed(quantity),
        parseFixed(price),
        fixed(100_000_000),
        currency,
      );
      const fee =
        fees.trim() === "" ? 0 : parseAmount(fees, currencyExponent(currency));
      const total = side === "buy" ? gross + fee : gross - fee;
      return total > 0 ? minorToInput(total, currency) : null;
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof RangeError) return null;
      throw err;
    }
  });

  $effect(() => {
    if (!amountTouched && suggested !== null) amount = suggested;
  });

  const securityLabel = $derived(
    security ? `${security.name} (${security.currency})` : "Choose a security",
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit trade" : "Add trade"}</Dialog.Title>
      <Dialog.Description>
        {#if isSplit}
          A split changes the number of shares you hold, not what you paid. The
          cost basis stays the same and the cost per share is divided.
        {:else}
          A trade changes the holdings, not the cash. Kept does not create a
          cash transaction for it: import your statements or add the cash
          movement by hand.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    {#if securities.length === 0}
      <p class="text-muted-foreground text-sm">
        Add the security you traded first.
      </p>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button href={resolve("/(app)/investments")}>Add a security</Button>
      </Dialog.Footer>
    {:else}
      <form
        method="POST"
        {action}
        class="grid gap-4"
        use:enhance={submitHandler({
          setPending: (v) => (pending = v),
          setErrors: (e) => (errors = e),
          knownFields: [
            "securityId",
            "date",
            "side",
            "quantity",
            "price",
            "fees",
            "amount",
            "note",
          ],
          successMessage: editing ? "Trade updated" : "Trade added",
          onSuccess: () => (open = false),
        })}
      >
        {#if trade}
          <input type="hidden" name="tradeId" value={trade.id} />
        {/if}
        <input type="hidden" name="securityId" value={securityId} />
        <input type="hidden" name="side" value={side} />

        <FormField
          label="Security"
          for="{uid}-security"
          errors={errors.securityId}
        >
          <Select.Root type="single" bind:value={securityId}>
            <Select.Trigger
              id="{uid}-security"
              aria-label="Security"
              class="w-full"
            >
              <span class="truncate">{securityLabel}</span>
            </Select.Trigger>
            <Select.Content>
              {#each securities as s (s.id)}
                <Select.Item value={s.id} label="{s.name} ({s.currency})">
                  {s.name} ({s.currency})
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <a
            href={resolve("/(app)/investments")}
            class="text-muted-foreground hover:text-foreground w-fit text-xs underline underline-offset-2"
          >
            Need another security? Create it under Investments
          </a>
        </FormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField label="Date" for="{uid}-date" errors={errors.date}>
            <Input
              id="{uid}-date"
              name="date"
              type="date"
              required
              value={trade?.date ?? todayIso()}
              aria-invalid={!!errors.date}
            />
          </FormField>
          <FormField label="Side" for="{uid}-side" errors={errors.side}>
            <Select.Root type="single" bind:value={side}>
              <Select.Trigger id="{uid}-side" aria-label="Side" class="w-full">
                {TRADE_SIDE_LABELS[side]}
              </Select.Trigger>
              <Select.Content>
                {#each TRADE_SIDES as s (s)}
                  <Select.Item value={s} label={TRADE_SIDE_LABELS[s]}>
                    {TRADE_SIDE_LABELS[s]}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </FormField>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField
            label={isSplit ? "Split ratio" : "Quantity"}
            for="{uid}-quantity"
            errors={errors.quantity}
            hint={isSplit
              ? "New shares per old share: 2 for a 2:1 split, 0.1 for a 1:10 reverse split. Applies from this date."
              : "Units, up to 8 decimals."}
          >
            <Input
              id="{uid}-quantity"
              name="quantity"
              inputmode="decimal"
              autocomplete="off"
              required
              class="text-end tabular-nums"
              placeholder="0"
              bind:value={quantity}
              aria-invalid={!!errors.quantity}
            />
          </FormField>
          {#if !isSplit}
            <FormField
              label="Price per unit{security ? ` (${security.currency})` : ''}"
              for="{uid}-price"
              errors={errors.price}
              hint="In the security's currency."
            >
              <Input
                id="{uid}-price"
                name="price"
                inputmode="decimal"
                autocomplete="off"
                required
                class="text-end tabular-nums"
                placeholder="0.00"
                bind:value={price}
                aria-invalid={!!errors.price}
              />
            </FormField>
          {/if}
        </div>

        {#if !isSplit}
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Fees ({currency}, optional)"
              for="{uid}-fees"
              errors={errors.fees}
            >
              <Input
                id="{uid}-fees"
                name="fees"
                inputmode="decimal"
                autocomplete="off"
                class="text-end tabular-nums"
                placeholder="0.00"
                bind:value={fees}
                aria-invalid={!!errors.fees}
              />
            </FormField>
            <FormField
              label="Amount ({currency})"
              for="{uid}-amount"
              errors={errors.amount}
              hint={sameCurrency
                ? "Cash paid or received including fees. Filled in from quantity, price and fees until you change it."
                : "Cash paid or received including fees, in your account's currency, as on your statement."}
            >
              <Input
                id="{uid}-amount"
                name="amount"
                inputmode="decimal"
                autocomplete="off"
                required
                class="text-end tabular-nums"
                placeholder="0.00"
                bind:value={amount}
                oninput={() => (amountTouched = true)}
                aria-invalid={!!errors.amount}
              />
            </FormField>
          </div>
        {/if}

        <FormField
          label="Note (optional)"
          for="{uid}-note"
          errors={errors.note}
        >
          <Textarea
            id="{uid}-note"
            name="note"
            maxlength={1000}
            rows={2}
            value={trade?.note ?? ""}
          />
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
            disabled={pending}>Cancel</Button
          >
          <Button type="submit" disabled={pending}>
            {#if pending}<Spinner />{/if}
            {editing ? "Save" : "Add trade"}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
