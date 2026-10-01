<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  let {
    title,
    description,
    actions,
    class: className,
  }: {
    title: string;
    description?: string | Snippet;
    actions?: Snippet;
    class?: string;
  } = $props();
</script>

<header
  class={cn(
    "flex flex-wrap items-end justify-between gap-x-4 gap-y-3",
    className,
  )}
>
  <div class="min-w-0">
    <h1 class="text-2xl font-semibold tracking-tight text-balance md:text-3xl">
      {title}
    </h1>
    {#if description}
      <p class="text-muted-foreground mt-1 text-sm">
        {#if typeof description === "string"}{description}{:else}{@render description()}{/if}
      </p>
    {/if}
  </div>
  {#if actions}
    <div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
  {/if}
</header>
