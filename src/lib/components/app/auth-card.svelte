<script lang="ts">
  import type { Snippet } from "svelte";
  import Logo from "./logo.svelte";

  let { children }: { children: Snippet } = $props();
</script>

<main class="flex min-h-svh items-center justify-center p-4">
  <div class="flex w-full max-w-sm flex-col gap-6">
    <Logo class="h-10 self-center" />
    {@render children()}
  </div>
</main>
