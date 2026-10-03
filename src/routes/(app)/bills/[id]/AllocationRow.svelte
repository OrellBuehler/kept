<script lang="ts">
  import { enhance } from "$app/forms";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import Amount from "$lib/components/Amount.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";

  import type { AllocationView } from "$lib/server/bills/allocations";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let {
    allocation,
    currency,
  }: { allocation: AllocationView; currency: string } = $props();

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  const tx = $derived(allocation.transaction);
  const messages = $derived(Object.values(errors).flat());
</script>

<li class="grid gap-1 p-4">
  <div class="flex items-start justify-between gap-3">
    <div class="grid min-w-0 gap-0.5 text-sm">
      <span class="font-medium break-words">
        {tx.counterpartyName ?? tx.description ?? "Transaction"}
      </span>
      <span class="text-muted-foreground truncate text-xs">
        {tx.accountName} · {prefs.date(tx.bookingDate)}
      </span>
      <span>
        <Badge variant={allocation.origin === "auto" ? "secondary" : "outline"}>
          {allocation.origin === "auto" ? "auto" : "manual"}
        </Badge>
      </span>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <Amount value={allocation.amount} {currency} flow class="font-semibold" />
      <form
        method="POST"
        action="?/removeAllocation"
        use:enhance={submitHandler({
          setPending: (v) => (pending = v),
          setErrors: (e) => (errors = e),
          knownFields: [],
          successMessage: "Payment removed",
        })}
      >
        <input type="hidden" name="allocationId" value={allocation.id} />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove this payment from the bill"
          disabled={pending}
        >
          {#if pending}<Spinner />{:else}<Trash2Icon />{/if}
        </Button>
      </form>
    </div>
  </div>
  {#if messages.length}
    <p class="text-destructive text-sm" role="alert">{messages.join(" ")}</p>
  {/if}
</li>
