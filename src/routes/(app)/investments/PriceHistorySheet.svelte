<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import * as Empty from "$lib/components/ui/empty";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { PRICE_SOURCE_LABELS } from "$lib/investment-labels";
  import { formatFixed } from "$lib/quantity";
  import { usePreferences } from "$lib/preferences.svelte";
  import ChartLineIcon from "@lucide/svelte/icons/chart-line";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import type { PageData } from "./$types";

  type History = NonNullable<PageData["priceHistory"]>;
  type Price = History["prices"][number];

  const prefs = usePreferences();

  let {
    open = $bindable(false),
    history,
  }: {
    open?: boolean;
    history: History | null;
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let price = $state("");
  let deleting = $state<Price | null>(null);
  let deleteOpen = $state(false);

  // Start every sheet with a clean form.
  $effect(() => {
    void history?.security.id;
    errors = {};
    price = "";
  });

  const unit = (v: Price["price"]) => formatFixed(v, prefs.locale, 2);
</script>

<Sheet.Root bind:open>
  <Sheet.Content class="w-full overflow-y-auto sm:max-w-md">
    {#if history}
      <Sheet.Header>
        <Sheet.Title class="break-words">{history.security.name}</Sheet.Title>
        <Sheet.Description>
          Price history in {history.security.currency}. A manual price wins over
          a fetched one on the same day.
        </Sheet.Description>
      </Sheet.Header>
      <div class="grid gap-6 px-4 pb-4">
        <form
          method="POST"
          action="?/setPrice"
          class="grid gap-3"
          use:enhance={submitHandler({
            setPending: (v) => (pending = v),
            setErrors: (e) => (errors = e),
            knownFields: ["date", "price"],
            successMessage: "Price saved",
            onSuccess: () => (price = ""),
          })}
        >
          <input type="hidden" name="securityId" value={history.security.id} />
          <div class="grid gap-3 sm:grid-cols-2">
            <FormField label="Date" for="{uid}-date" errors={errors.date}>
              <Input
                id="{uid}-date"
                name="date"
                type="date"
                required
                value={todayIso()}
                aria-invalid={!!errors.date}
              />
            </FormField>
            <FormField
              label="Price ({history.security.currency})"
              for="{uid}-price"
              errors={errors.price}
            >
              <Input
                id="{uid}-price"
                name="price"
                inputmode="decimal"
                autocomplete="off"
                required
                class="text-end tabular-nums"
                placeholder="0.00"
                bind:value={price}
                aria-invalid={!!errors.price}
              />
            </FormField>
          </div>
          {#if errors.form?.length}
            <p class="text-destructive text-sm" role="alert">
              {errors.form.join(" ")}
            </p>
          {/if}
          <Button type="submit" class="w-fit" disabled={pending}>
            {#if pending}<Spinner />{/if}
            Set price
          </Button>
        </form>

        {#if history.prices.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><ChartLineIcon /></Empty.Media>
              <Empty.Title>No prices yet</Empty.Title>
              <Empty.Description>
                Set a price by hand{history.security.symbol
                  ? ", or refresh prices under Settings > Market data"
                  : ""}. Until then the last trade price is used.
              </Empty.Description>
            </Empty.Header>
          </Empty.Root>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Date</Table.Head>
                <Table.Head class="text-end">Price</Table.Head>
                <Table.Head>Source</Table.Head>
                <Table.Head class="w-10">
                  <span class="sr-only">Actions</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each history.prices as p (p.id)}
                <Table.Row>
                  <Table.Cell class="whitespace-nowrap">
                    {prefs.date(p.date)}
                  </Table.Cell>
                  <Table.Cell class="text-end tabular-nums">
                    {unit(p.price)}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge
                      variant={p.source === "manual" ? "secondary" : "outline"}
                    >
                      {PRICE_SOURCE_LABELS[p.source]}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell class="text-end">
                    {#if p.source === "manual"}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete price from {prefs.date(p.date)}"
                        onclick={() => {
                          deleting = p;
                          deleteOpen = true;
                        }}
                      >
                        <Trash2Icon />
                      </Button>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
          {#if history.total > history.prices.length}
            <p class="text-muted-foreground text-sm">
              Showing the latest {history.prices.length} of {history.total} prices.
              <a
                class="underline"
                href="{resolve('/(app)/investments')}?prices={history.security
                  .id}&all=1"
              >
                Show all
              </a>
            </p>
          {/if}
        {/if}
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete this price?"
  description="The manual price from {deleting
    ? prefs.date(deleting.date)
    : ''} will be removed. A fetched price for that day, if any, applies again."
  action="?/deletePrice"
  fields={{ priceId: deleting?.id ?? "" }}
  successMessage="Price deleted"
/>
