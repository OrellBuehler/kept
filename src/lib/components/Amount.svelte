<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Minor } from "$lib/money";
  import { usePreferences } from "$lib/preferences.svelte";

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

  const prefs = usePreferences();

  const text = $derived(
    (flow && value > 0 ? "+" : "") + prefs.amount(value, currency),
  );
</script>

<!-- A blurred amount must be focusable so keyboard users can reveal it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span
  class={cn(
    "whitespace-nowrap tabular-nums",
    value < 0 && "text-destructive",
    flow && value > 0 && "text-emerald-600 dark:text-emerald-400",
    prefs.blur &&
      "cursor-default blur-sm transition select-none hover:blur-none focus:blur-none",
    className,
  )}
  tabindex={prefs.blur ? 0 : undefined}>{text}</span
>
