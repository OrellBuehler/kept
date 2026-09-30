<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import { cn } from "$lib/utils";

  let { current }: { current: 1 | 2 | 3 | 4 } = $props();

  const steps = ["Choose account", "Upload", "Review", "Done"];
</script>

<ol class="flex items-center gap-2 text-sm" aria-label="Import progress">
  {#each steps as label, i (label)}
    {@const n = i + 1}
    <li
      class="flex items-center gap-2"
      aria-current={n === current ? "step" : undefined}
    >
      <span
        class={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
          n < current && "border-primary bg-primary text-primary-foreground",
          n === current && "border-primary text-primary",
          n > current && "text-muted-foreground",
        )}
      >
        {#if n < current}<CheckIcon class="size-3.5" />{:else}{n}{/if}
      </span>
      <span
        class={cn(
          n === current
            ? "font-medium"
            : "text-muted-foreground hidden sm:inline",
        )}>{label}</span
      >
      {#if n < steps.length}
        <span class="bg-border h-px w-3 sm:w-8" aria-hidden="true"></span>
      {/if}
    </li>
  {/each}
</ol>
