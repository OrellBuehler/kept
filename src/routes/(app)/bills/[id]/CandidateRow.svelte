<script lang="ts">
  import { enhance } from "$app/forms";
  import Amount from "$lib/components/Amount.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import { minorToSignedInput } from "$lib/amount-input";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { formatDate } from "$lib/format";
  import { minor } from "$lib/money";
  import type { CandidateTransaction } from "$lib/server/bills/candidates";

  let {
    candidate,
    currency,
  }: { candidate: CandidateTransaction; currency: string } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  const refund = $derived(candidate.suggestedAmount < 0);
  const partial = $derived(
    Math.abs(candidate.unallocated) !== Math.abs(candidate.amount),
  );
  const messages = $derived([
    ...(errors.amount ?? []),
    ...(errors.transactionId ?? []),
    ...(errors.form ?? []),
  ]);
</script>

<li class="grid gap-3 p-4">
  <div class="flex items-start justify-between gap-3">
    <div class="grid min-w-0 gap-0.5 text-sm">
      <span class="truncate font-medium">
        {candidate.counterpartyName ?? candidate.description ?? "Transaction"}
      </span>
      {#if candidate.counterpartyName && candidate.description}
        <span class="text-muted-foreground truncate text-xs">
          {candidate.description}
        </span>
      {/if}
      <span class="text-muted-foreground truncate text-xs">
        {candidate.accountName} · {formatDate(candidate.bookingDate)}
      </span>
    </div>
    <div class="grid shrink-0 justify-items-end gap-0.5">
      <Amount
        value={candidate.amount}
        currency={candidate.currency}
        flow
        class="font-semibold"
      />
      {#if partial}
        <span class="text-muted-foreground text-xs">
          <Amount
            value={minor(Math.abs(candidate.unallocated))}
            currency={candidate.currency}
            class="text-xs"
          /> unallocated
        </span>
      {/if}
    </div>
  </div>

  <form
    method="POST"
    action="?/allocate"
    class="grid gap-1.5"
    use:enhance={submitHandler({
      setPending: (v) => (pending = v),
      setErrors: (e) => (errors = e),
      knownFields: ["amount", "transactionId"],
      successMessage: "Payment matched",
    })}
  >
    <input type="hidden" name="transactionId" value={candidate.id} />
    <div class="flex items-end gap-2">
      <div class="grid min-w-0 flex-1 gap-1">
        <label for="{uid}-amount" class="text-muted-foreground text-xs">
          {#if refund}
            Refund amount ({currency}), negative
          {:else}
            Amount to apply ({currency})
          {/if}
        </label>
        <Input
          id="{uid}-amount"
          name="amount"
          inputmode="decimal"
          autocomplete="off"
          class="text-end tabular-nums"
          value={minorToSignedInput(candidate.suggestedAmount, currency)}
          aria-invalid={messages.length > 0}
        />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {#if pending}<Spinner />{/if}
        Allocate
      </Button>
    </div>
    {#if refund}
      <div class="flex items-center gap-2">
        <Badge
          variant="outline"
          class="border-transparent bg-violet-100 text-violet-900 dark:bg-violet-400/15 dark:text-violet-300"
        >
          Refund
        </Badge>
        <span class="text-muted-foreground text-xs">
          A negative amount records money coming back for this bill.
        </span>
      </div>
    {/if}
    {#if messages.length}
      <p class="text-destructive text-sm" role="alert">{messages.join(" ")}</p>
    {/if}
  </form>
</li>
