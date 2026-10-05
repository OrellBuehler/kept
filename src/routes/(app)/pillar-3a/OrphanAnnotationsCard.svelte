<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import type { OrphanAnnotation } from "$lib/server/pillar3a";
  import { usePreferences } from "$lib/preferences.svelte";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  const prefs = usePreferences();

  let { orphans }: { orphans: OrphanAnnotation[] } = $props();

  let deleteOpen = $state(false);
  let deleting = $state<OrphanAnnotation | null>(null);

  function askDelete(o: OrphanAnnotation) {
    deleting = o;
    deleteOpen = true;
  }
</script>

{#if orphans.length > 0}
  <Card.Root>
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <TriangleAlertIcon class="size-4 shrink-0" /> Detached annotations
      </Card.Title>
      <Card.Description>
        These annotations belong to payments that are no longer detected as
        contributions (the reference changed or the payment was refunded). They
        do not count as contributions. A buy-in among them keeps its gap years
        closed until you delete it.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <ul class="divide-y">
        {#each orphans as o (o.id)}
          <li class="flex flex-wrap items-center justify-between gap-2 py-3">
            <div class="grid gap-0.5 text-sm">
              <span class="font-medium">{o.portfolioName}</span>
              <span class="text-muted-foreground">
                {prefs.date(o.date)} ·
                {o.kind === "buy_in"
                  ? `Buy-in for ${o.gapYears.join(", ") || "no year"}`
                  : "Ordinary"}
              </span>
            </div>
            <Button size="sm" variant="outline" onclick={() => askDelete(o)}>
              Delete
            </Button>
          </li>
        {/each}
      </ul>
    </Card.Content>
  </Card.Root>

  <ConfirmActionDialog
    bind:open={deleteOpen}
    title="Delete this annotation?"
    description="The annotation is removed and any gap years it holds are released."
    action="?/deleteContribution"
    fields={{ contributionId: deleting?.id ?? "" }}
    successMessage="Annotation deleted"
  />
{/if}
