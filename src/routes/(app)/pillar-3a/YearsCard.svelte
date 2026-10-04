<script lang="ts">
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import CalendarIcon from "@lucide/svelte/icons/calendar";
  import type { Pillar3aYearOverview } from "$lib/server/pillar3a";
  import YearRow from "./YearRow.svelte";

  let { years, thisYear }: { years: Pillar3aYearOverview[]; thisYear: number } =
    $props();
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Years</Card.Title>
    <Card.Description>
      Limits are per person, across all your 3a accounts. A payment counts for
      the year it is credited. Missed years from 2025 on can be bought in later.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    {#if years.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><CalendarIcon /></Empty.Media>
          <Empty.Title>No years yet</Empty.Title>
          <Empty.Description>
            Years appear here once there are contributions to track.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else}
      <ul class="divide-y">
        {#each years as row (row.year)}
          <YearRow {row} {thisYear} />
        {/each}
      </ul>
    {/if}
  </Card.Content>
</Card.Root>
