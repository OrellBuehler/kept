<script lang="ts">
  import { onMount } from "svelte";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let { ms }: { ms: number } = $props();

  // Server-rendered in UTC so hydration matches; switched to the browser's zone once mounted.
  let mounted = $state(false);
  onMount(() => (mounted = true));

  const text = $derived(
    mounted ? prefs.dateTime(ms) : `${prefs.dateTime(ms, "UTC")} UTC`,
  );
</script>

<time datetime={new Date(ms).toISOString()} class="tabular-nums">{text}</time>
