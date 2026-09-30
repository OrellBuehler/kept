<script lang="ts">
  import { cn } from "$lib/utils";
  import { formatAmount, type Minor } from "$lib/money";

  let {
    value,
    currency,
    flow = false,
    class: className,
  }: {
    value: Minor;
    currency: string;
    /** Transaction-style: positive amounts get a plus sign and a positive colour. */
    flow?: boolean;
    class?: string;
  } = $props();

  const text = $derived(
    (flow && value > 0 ? "+" : "") + formatAmount(value, currency),
  );
</script>

<span
  class={cn(
    "whitespace-nowrap tabular-nums",
    value < 0 && "text-destructive",
    flow && value > 0 && "text-emerald-600 dark:text-emerald-400",
    className,
  )}>{text}</span
>
