<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import { plural } from "$lib/import-ui";
  import type { NeedsAmountView } from "$lib/server/transfers/manual";
  import NeedsAmountRow from "./NeedsAmountRow.svelte";

  let { items }: { items: NeedsAmountView[] } = $props();
</script>

<Card.Root class="border-amber-500/50">
  <Card.Header>
    <Card.Title>Needs amount</Card.Title>
    <Card.Description>
      {plural(items.length, "transfer")} in another currency. Enter the amount this
      account booked and Kept creates the transaction.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <ul class="divide-y rounded-md border">
      {#each items as item (item.transferId)}
        <NeedsAmountRow {item} />
      {/each}
    </ul>
  </Card.Content>
</Card.Root>
