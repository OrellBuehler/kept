<script lang="ts">
  import { enhance } from "$app/forms";
  import ArrowLeftRightIcon from "@lucide/svelte/icons/arrow-left-right";
  import CheckIcon from "@lucide/svelte/icons/check";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import XIcon from "@lucide/svelte/icons/x";
  import Amount from "$lib/components/Amount.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import { minorToSignedInput } from "$lib/amount-input";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";

  import type { SuggestionView } from "$lib/server/bills/suggestions";
  import { cn } from "$lib/utils";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let {
    suggestion,
    confirmAction,
    dismissAction,
    showBill = true,
    includeBillId = true,
    focused = false,
    onfocusmatches,
  }: {
    suggestion: SuggestionView;
    confirmAction: string;
    dismissAction: string;
    /** Show the bill side; off on the bill's own page. */
    showBill?: boolean;
    /** The overview actions need the bill id; the bill page actions do not. */
    includeBillId?: boolean;
    /** The list is narrowed to the matches that compete with this one. */
    focused?: boolean;
    /** Given where the competing matches are in the same list: narrows the list to them, or back. */
    onfocusmatches?: () => void;
  } = $props();

  let confirming = $state(false);
  let dismissing = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  const busy = $derived(confirming || dismissing);
  const refund = $derived(suggestion.amount < 0);
  const tx = $derived(suggestion.transaction);
  const bill = $derived(suggestion.bill);
  const competing = $derived(suggestion.otherBills + suggestion.otherPayments);
  const plural = (n: number, one: string, many: string) =>
    n === 1 ? one : `${n} ${many}`;
  const reasons = $derived.by(() => {
    const out: string[] = [];
    if (suggestion.ibanMismatch) {
      out.push(
        "The reference matches, but the payment went to a different account than the bill names.",
      );
    }
    if (suggestion.otherBills > 0) {
      out.push(
        `This payment also fits ${plural(suggestion.otherBills, "another bill", "other bills")}. Confirm it for the one it paid.`,
      );
    }
    if (suggestion.otherPayments > 0) {
      out.push(
        `${plural(suggestion.otherPayments, "Another payment", "other payments")} also ${suggestion.otherPayments === 1 ? "fits" : "fit"} this bill. Confirm each one that paid it, such as instalments.`,
      );
    }
    if (out.length === 0) {
      out.push(
        "A competing match was dismissed earlier, so Kept leaves this one to you.",
      );
    }
    return out;
  });
  const ambiguousLabel = $derived(
    competing > 0
      ? "Several matches"
      : suggestion.ibanMismatch
        ? "Different account"
        : "Check before confirming",
  );
  const ambiguousClass =
    "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300";
  const known = ["amount", "billId", "transactionId"];
  const messages = $derived(Object.values(errors).flat());
</script>

<li class="grid gap-3 p-4">
  <div class="flex flex-wrap items-center gap-2">
    <Badge variant="secondary">
      {suggestion.rule === "reference" ? "Reference" : "IBAN + amount"}
    </Badge>
    {#if suggestion.ambiguous}
      {#if onfocusmatches && competing > 0}
        <button
          type="button"
          class="focus-visible:ring-ring/50 rounded-full outline-none focus-visible:ring-[3px]"
          aria-pressed={focused}
          onclick={onfocusmatches}
        >
          <Badge
            variant="outline"
            class={cn(ambiguousClass, "cursor-pointer underline-offset-2")}
          >
            <TriangleAlertIcon />
            {ambiguousLabel}
            <span class="font-normal underline">
              {focused ? "show all" : "show them"}
            </span>
          </Badge>
        </button>
      {:else}
        <Badge variant="outline" class={ambiguousClass}>
          <TriangleAlertIcon />
          {ambiguousLabel}
        </Badge>
      {/if}
    {/if}
    {#if refund}
      <Badge
        variant="outline"
        class="border-transparent bg-violet-100 text-violet-900 dark:bg-violet-400/15 dark:text-violet-300"
      >
        Refund
      </Badge>
    {/if}
  </div>

  {#if suggestion.ambiguous}
    <p class="text-muted-foreground text-xs">{reasons.join(" ")}</p>
  {/if}

  <div
    class={cn(
      "grid items-start gap-3 sm:gap-4",
      showBill && "sm:grid-cols-[1fr_auto_1fr]",
    )}
  >
    {#if showBill}
      <div class="grid min-w-0 gap-0.5 text-sm">
        <span class="truncate font-medium">
          {bill.creditorName ?? "Unnamed creditor"}
        </span>
        {#if bill.invoiceNumber}
          <span class="text-muted-foreground truncate text-xs">
            No. {bill.invoiceNumber}
          </span>
        {/if}
        <span class="text-muted-foreground text-xs">
          {#if bill.amount !== null}
            <Amount
              value={bill.amount}
              currency={bill.currency}
              class="text-xs"
            />
          {:else}
            Open amount
          {/if}
          {#if bill.dueDate}· due {prefs.date(bill.dueDate)}{/if}
        </span>
      </div>
      <ArrowLeftRightIcon
        class="text-muted-foreground hidden size-4 self-center sm:block"
        aria-hidden="true"
      />
    {/if}
    <div class="grid min-w-0 gap-0.5 text-sm">
      <span class="truncate font-medium">
        {tx.counterpartyName ?? tx.description ?? "Transaction"}
      </span>
      <span class="text-muted-foreground truncate text-xs">
        {tx.accountName} · {prefs.date(tx.bookingDate)}
      </span>
      <span class="text-xs">
        <Amount value={tx.amount} currency={tx.currency} flow class="text-xs" />
        {#if suggestion.amount !== Math.abs(tx.amount) || refund}
          <span class="text-muted-foreground">
            · applies
            <Amount
              value={suggestion.amount}
              currency={bill.currency}
              class="text-xs"
            />
          </span>
        {/if}
      </span>
    </div>
  </div>

  {#if messages.length}
    <p class="text-destructive text-sm" role="alert">{messages.join(" ")}</p>
  {/if}

  <div class="flex flex-wrap gap-2">
    <form
      method="POST"
      action={confirmAction}
      use:enhance={submitHandler({
        setPending: (v) => (confirming = v),
        setErrors: (e) => (errors = e),
        knownFields: known,
        successMessage: "Payment matched",
      })}
    >
      {#if includeBillId}
        <input type="hidden" name="billId" value={bill.id} />
      {/if}
      <input type="hidden" name="transactionId" value={tx.id} />
      <input
        type="hidden"
        name="amount"
        value={minorToSignedInput(suggestion.amount, bill.currency)}
      />
      <Button type="submit" size="sm" disabled={busy}>
        {#if confirming}<Spinner />{:else}<CheckIcon />{/if}
        Confirm
      </Button>
    </form>
    <form
      method="POST"
      action={dismissAction}
      use:enhance={submitHandler({
        setPending: (v) => (dismissing = v),
        setErrors: (e) => (errors = e),
        knownFields: known,
      })}
    >
      {#if includeBillId}
        <input type="hidden" name="billId" value={bill.id} />
      {/if}
      <input type="hidden" name="transactionId" value={tx.id} />
      <Button type="submit" variant="outline" size="sm" disabled={busy}>
        {#if dismissing}<Spinner />{:else}<XIcon />{/if}
        Dismiss
      </Button>
    </form>
  </div>
</li>
