<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Table from "$lib/components/ui/table";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import type { PortfolioValueView } from "$lib/server/pillar3a";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let {
    open = $bindable(false),
    name,
    values,
    currency,
    onDelete,
  }: {
    open?: boolean;
    name: string;
    values: PortfolioValueView[];
    currency: string;
    onDelete: (value: PortfolioValueView) => void;
  } = $props();
</script>

<Sheet.Root bind:open>
  <Sheet.Content class="w-full overflow-y-auto sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>{name}</Sheet.Title>
      <Sheet.Description>Value history, newest first.</Sheet.Description>
    </Sheet.Header>
    <div class="px-4 pb-4">
      {#if values.length === 0}
        <p class="text-muted-foreground text-sm">No values entered yet.</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Date</Table.Head>
              <Table.Head class="text-end">Value</Table.Head>
              <Table.Head class="w-10"
                ><span class="sr-only">Actions</span></Table.Head
              >
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each values as v (v.id)}
              <Table.Row>
                <Table.Cell class="whitespace-nowrap">
                  {prefs.date(v.date)}
                  {#if v.note}
                    <div
                      class="text-muted-foreground max-w-40 truncate text-xs"
                    >
                      {v.note}
                    </div>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-end">
                  <Amount value={v.amount} {currency} />
                </Table.Cell>
                <Table.Cell class="text-end">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete value from {prefs.date(v.date)}"
                    onclick={() => onDelete(v)}
                  >
                    <Trash2Icon />
                  </Button>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
