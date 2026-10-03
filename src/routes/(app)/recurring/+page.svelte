<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import { submitHandler } from "$lib/form-submit";
  import { CADENCE_LABELS } from "$lib/recurring-types";
  import CheckIcon from "@lucide/svelte/icons/check";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import RepeatIcon from "@lucide/svelte/icons/repeat";
  import UndoIcon from "@lucide/svelte/icons/undo-2";
  import XIcon from "@lucide/svelte/icons/x";
  import type { PageData, PageProps } from "./$types";
  import SeriesEditDialog from "./SeriesEditDialog.svelte";

  type Series = PageData["series"][number];

  let { data }: PageProps = $props();

  let editOpen = $state(false);
  let editing = $state<Series | null>(null);

  const confirmed = $derived(
    data.series.filter((s) => s.status === "confirmed"),
  );
  const suggested = $derived(
    data.series.filter((s) => s.status === "suggested"),
  );
  const dismissed = $derived(
    data.series.filter((s) => s.status === "dismissed"),
  );

  const submit = (message: string) =>
    submitHandler({
      setPending: () => {},
      setErrors: (e) => {
        const text = Object.values(e).flat().join(" ");
        if (text) toast.error(text);
      },
      successMessage: message,
    });
</script>

<svelte:head>
  <title>Recurring · Kept</title>
</svelte:head>

{#snippet actionForm(
  action: string,
  id: string,
  label: string,
  message: string,
  variant: "default" | "outline" | "ghost",
)}
  <form method="POST" action="?/{action}" use:enhance={submit(message)}>
    <input type="hidden" name="id" value={id} />
    <Button type="submit" size="sm" {variant}>
      {#if action === "confirm"}<CheckIcon
        />{:else if action === "dismiss"}<XIcon />{:else}<UndoIcon />{/if}
      {label}
    </Button>
  </form>
{/snippet}

{#snippet row(s: Series)}
  <li class="flex flex-wrap items-center justify-between gap-3 py-3">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <span class="truncate font-medium">{s.name}</span>
        <Badge variant="secondary">{CADENCE_LABELS[s.cadence]}</Badge>
        {#if s.priceChange}
          <Badge variant="destructive">
            Price changed
            <Amount value={s.priceChange.previous} currency={s.currency} />
            →
            <Amount value={s.priceChange.latest} currency={s.currency} />
          </Badge>
        {/if}
        {#if s.overdue && s.status === "confirmed"}
          <Badge variant="outline">Overdue</Badge>
        {/if}
      </div>
      <p class="text-muted-foreground mt-1 text-xs">
        Last seen {s.lastDate} · next expected {s.nextExpected} · {s.occurrences}
        payments
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <div class="text-right text-sm">
        <Amount value={s.amount} currency={s.currency} flow />
        <p class="text-muted-foreground text-xs">
          <Amount
            value={s.annualCost}
            currency={s.currency}
            class="text-muted-foreground"
          /> per year
        </p>
      </div>
      <div class="flex items-center gap-1">
        {#if s.status === "suggested"}
          {@render actionForm(
            "confirm",
            s.id,
            "Confirm",
            "Series confirmed",
            "default",
          )}
          {@render actionForm(
            "dismiss",
            s.id,
            "Dismiss",
            "Series dismissed",
            "outline",
          )}
        {:else if s.status === "confirmed"}
          {@render actionForm(
            "dismiss",
            s.id,
            "Dismiss",
            "Series dismissed",
            "ghost",
          )}
        {:else}
          {@render actionForm(
            "restore",
            s.id,
            "Restore",
            "Series restored",
            "outline",
          )}
        {/if}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Edit {s.name}"
          onclick={() => {
            editing = s;
            editOpen = true;
          }}
        >
          <PencilIcon />
        </Button>
      </div>
    </div>
  </li>
{/snippet}

<PageHeader
  title="Recurring"
  description="Subscriptions, rent, salary and other payments that repeat. Detected from your transactions."
  class="mb-6"
/>

{#if data.series.length === 0}
  <Empty.Root class="border border-dashed">
    <Empty.Header>
      <Empty.Media variant="icon"><RepeatIcon /></Empty.Media>
      <Empty.Title>No recurring payments found</Empty.Title>
      <Empty.Description>
        Import a few months of transactions. Payments to the same counterparty
        at a regular interval show up here.
      </Empty.Description>
    </Empty.Header>
  </Empty.Root>
{:else}
  <div class="grid gap-4">
    {#if data.totals.length > 0}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {#each data.totals as t (t.currency)}
          <Card.Root>
            <Card.Header>
              <Card.Title>{t.currency}</Card.Title>
              <Card.Description>Confirmed recurring payments</Card.Description>
            </Card.Header>
            <Card.Content class="grid gap-1 text-sm">
              <p class="flex justify-between">
                <span class="text-muted-foreground">Monthly</span>
                <Amount value={t.outflowMonthly} currency={t.currency} />
              </p>
              <p class="flex justify-between">
                <span class="text-muted-foreground">Annual</span>
                <Amount value={t.outflowAnnual} currency={t.currency} />
              </p>
              {#if t.inflowAnnual > 0}
                <p class="flex justify-between">
                  <span class="text-muted-foreground"
                    >Recurring income, annual</span
                  >
                  <Amount value={t.inflowAnnual} currency={t.currency} />
                </p>
              {/if}
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    {/if}

    {#if suggested.length > 0}
      <Card.Root>
        <Card.Header>
          <Card.Title>To review</Card.Title>
          <Card.Description>
            Confirm the ones that are real; dismissed ones are not suggested
            again.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <ul class="divide-y">
            {#each suggested as s (s.id)}{@render row(s)}{/each}
          </ul>
        </Card.Content>
      </Card.Root>
    {/if}

    {#if confirmed.length > 0}
      <Card.Root>
        <Card.Header><Card.Title>Confirmed</Card.Title></Card.Header>
        <Card.Content>
          <ul class="divide-y">
            {#each confirmed as s (s.id)}{@render row(s)}{/each}
          </ul>
        </Card.Content>
      </Card.Root>
    {/if}

    {#if dismissed.length > 0}
      <Card.Root>
        <Card.Header><Card.Title>Dismissed</Card.Title></Card.Header>
        <Card.Content>
          <ul class="divide-y">
            {#each dismissed as s (s.id)}{@render row(s)}{/each}
          </ul>
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}

<SeriesEditDialog bind:open={editOpen} series={editing} />
