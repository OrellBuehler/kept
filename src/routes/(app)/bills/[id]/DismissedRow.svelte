<script lang="ts">
  import { enhance } from "$app/forms";
  import UndoIcon from "@lucide/svelte/icons/undo-2";
  import Amount from "$lib/components/Amount.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { formatDate } from "$lib/format";
  import type { TransactionDisplay } from "$lib/server/bills/display";

  let { transaction }: { transaction: TransactionDisplay } = $props();

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  const messages = $derived(Object.values(errors).flat());
</script>

<li class="grid gap-1 p-3">
  <div class="flex items-center justify-between gap-3">
    <div class="grid min-w-0 gap-0.5 text-sm">
      <span class="truncate">
        {transaction.counterpartyName ??
          transaction.description ??
          "Transaction"}
      </span>
      <span class="text-muted-foreground truncate text-xs">
        {transaction.accountName} · {formatDate(transaction.bookingDate)} ·
        <Amount
          value={transaction.amount}
          currency={transaction.currency}
          flow
          class="text-xs"
        />
      </span>
    </div>
    <form
      method="POST"
      action="?/undismiss"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [],
        successMessage: "Suggestion restored",
      })}
    >
      <input type="hidden" name="transactionId" value={transaction.id} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {#if pending}<Spinner />{:else}<UndoIcon />{/if}
        Restore
      </Button>
    </form>
  </div>
  {#if messages.length}
    <p class="text-destructive text-sm" role="alert">{messages.join(" ")}</p>
  {/if}
</li>
