<script lang="ts">
  import type { Snippet } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { cn } from "$lib/utils";

  let {
    label,
    for: htmlFor,
    errors,
    hint,
    class: className,
    children,
  }: {
    label: string;
    for: string;
    errors?: string[];
    hint?: string;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<div class={cn("grid content-start gap-1.5", className)}>
  <Label for={htmlFor}>{label}</Label>
  {@render children()}
  {#if hint}
    <p class="text-muted-foreground text-xs">{hint}</p>
  {/if}
  {#if errors?.length}
    <p class="text-destructive text-sm" role="alert">{errors[0]}</p>
  {/if}
</div>
