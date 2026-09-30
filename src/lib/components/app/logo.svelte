<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className }: { class?: string } = $props();
</script>

<img
  src="/brand/kept-lockup.svg"
  alt="Kept"
  class={cn("h-10 w-auto dark:invert", className)}
/>
