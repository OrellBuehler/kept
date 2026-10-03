<script lang="ts">
  import Amount from "$lib/components/Amount.svelte";
  import type { TaxBalance } from "$lib/server/tax/matching";
  import { cn } from "$lib/utils";

  let {
    balance,
    currency,
    class: className,
  }: { balance: TaxBalance; currency: string; class?: string } = $props();
</script>

{#if balance.outcome === "due"}
  <span class={cn("font-medium whitespace-nowrap tabular-nums", className)}>
    Due <Amount value={balance.amountDue} {currency} />
  </span>
{:else if balance.outcome === "refund"}
  <span
    class={cn(
      "font-medium whitespace-nowrap text-emerald-600 tabular-nums dark:text-emerald-400",
      className,
    )}
  >
    Refund <Amount value={balance.refundExpected} {currency} />
  </span>
{:else if balance.outcome === "settled"}
  <span class={cn("text-muted-foreground", className)}>Settled</span>
{:else}
  <span class={cn("text-muted-foreground", className)}>No assessment</span>
{/if}
