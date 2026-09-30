<script lang="ts">
  import { onMount } from "svelte";
  import { timeAgo } from "$lib/import-ui";

  let {
    ms,
    mode = "ago",
    class: className,
  }: { ms: number; mode?: "ago" | "datetime"; class?: string } = $props();

  // Server output is timezone-neutral (UTC); the browser upgrades it after mount.
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });

  const iso = $derived(new Date(ms).toISOString());
  const text = $derived.by(() => {
    if (mode === "ago") {
      return mounted ? timeAgo(ms, Date.now()) : iso.slice(0, 10);
    }
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(mounted ? {} : { timeZone: "UTC" }),
    }).format(new Date(ms));
  });
</script>

<time
  datetime={iso}
  class={className}
  title={mounted ? new Date(ms).toLocaleString("en-GB") : undefined}
  >{text}</time
>
