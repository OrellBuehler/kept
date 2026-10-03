<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { FULL_SHARE_BPS, formatShare } from "$lib/money";
  import UsersIcon from "@lucide/svelte/icons/users";

  let {
    shareBps,
    sharedWith = null,
    class: className,
  }: {
    shareBps: number;
    sharedWith?: string | null;
    class?: string;
  } = $props();
</script>

{#if shareBps < FULL_SHARE_BPS}
  <Badge
    variant="outline"
    class={className}
    title={sharedWith ? `Shared with ${sharedWith}` : undefined}
  >
    <UsersIcon class="size-3" aria-hidden="true" />
    Shared · {formatShare(shareBps)}
  </Badge>
{/if}
