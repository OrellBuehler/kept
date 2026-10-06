<script lang="ts">
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import { isSafeLinkUrl } from "$lib/external-links";
  import { cn } from "$lib/utils";

  interface Link {
    id: string;
    label: string;
    url: string;
    source: string;
  }

  let {
    links,
    prefix = true,
    class: className,
  }: { links: Link[]; prefix?: boolean; class?: string } = $props();

  // Rows are validated when written; the check here keeps a bad row from ever becoming a clickable link.
  const safe = $derived(
    links
      .filter((l) => isSafeLinkUrl(l.url))
      .map((l) => ({ ...l, host: new URL(l.url).host })),
  );
</script>

{#if safe.length > 0}
  <ul
    aria-label="Links from other apps"
    class={cn("flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm", className)}
  >
    {#each safe as link (link.id)}
      <li class="flex max-w-full min-w-0 items-center gap-1">
        {#if prefix}
          <span class="text-muted-foreground shrink-0">Linked:</span>
        {/if}
        <a
          href={link.url}
          target="_blank"
          rel="external noopener noreferrer"
          title="{link.source}: {link.url}"
          class="focus-visible:ring-ring/50 inline-flex min-w-0 items-center gap-1 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px]"
        >
          <span class="truncate">{link.label}</span>
          <span class="text-muted-foreground shrink-0 text-xs"
            >({link.host})</span
          >
          <ExternalLinkIcon class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="sr-only">(opens in a new tab)</span>
        </a>
      </li>
    {/each}
  </ul>
{/if}
