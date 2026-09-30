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
  import { formatDate } from "$lib/format";
  import type { SuggestionView } from "$lib/server/bills/suggestions";
  import { cn } from "$lib/utils";

  let {
    suggestion,
    confirmAction,
    dismissAction,
    showBill = true,
    includeBillId = true,
  }: {
    suggestion: SuggestionView;
    confirmAction: string;
    dismissAction: string;
    /** Show the bill side; off on the bill's own page. */
    showBill?: boolean;
    /** The overview actions need the bill id; the bill page actions do not. */
    includeBillId?: boolean;
  } = $props();

  let confirming = $state(false);
  let dismissing = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  const busy = $derived(confirming || dismissing);
  const refund = $derived(suggestion.amount < 0);
  const tx = $derived(suggestion.transaction);
  const bill = $derived(suggestion.bill);
  const known = ["amount", "billId", "transactionId"];
  const messages = $derived(Object.values(errors).flat());
</script>

<li class="grid gap-3 p-4">
  <div class="flex flex-wrap items-center gap-2">
    <Badge variant="secondary">
      {suggestion.rule === "reference" ? "Reference" : "IBAN + amount"}
    </Badge>
    {#if suggestion.ambiguous}
      <Badge
        variant="outline"
        class="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300"
      >
        <TriangleAlertIcon /> Several matches
      </Badge>
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
          {#if bill.dueDate}· due {formatDate(bill.dueDate)}{/if}
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
        {tx.accountName} · {formatDate(tx.bookingDate)}
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
