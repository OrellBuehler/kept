<script lang="ts">
  import { onMount } from "svelte";
  import { formatDateTime } from "$lib/format";

  let { ms }: { ms: number } = $props();

  // Server-rendered in UTC so hydration matches; switched to the browser's zone once mounted.
  let mounted = $state(false);
  onMount(() => (mounted = true));

  const text = $derived(
    mounted ? formatDateTime(ms) : `${formatDateTime(ms, "UTC")} UTC`,
  );
</script>

<time datetime={new Date(ms).toISOString()} class="tabular-nums">{text}</time>
