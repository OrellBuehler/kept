<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { resolve } from "$app/paths";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import ScaleIcon from "@lucide/svelte/icons/scale";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import Amount from "$lib/components/Amount.svelte";
  import TaxOutcome from "$lib/components/tax/TaxOutcome.svelte";
  import TaxYearForm from "$lib/components/tax/TaxYearForm.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Taxes · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <PageHeader
    title="Taxes"
    description="Compare what you paid with what the tax office counted, year by year. Payments count once you mark a transaction, or a bill, with its tax year."
  />

  {#if data.years.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><ScaleIcon /></Empty.Media>
        <Empty.Title>No tax years yet</Empty.Title>
        <Empty.Description>
          Add a year below, or mark a transaction as a tax payment from its
          account.
        </Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {:else}
    <Card.Root>
      <Card.Content>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head class="w-20">Year</Table.Head>
              <Table.Head class="hidden md:table-cell">Authority</Table.Head>
              <Table.Head class="text-end">Paid by you</Table.Head>
              <Table.Head class="hidden text-end sm:table-cell"
                >Counted</Table.Head
              >
              <Table.Head class="text-end">Open</Table.Head>
              <Table.Head class="w-36">Status</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each data.years as y (y.year)}
              <Table.Row>
                <Table.Cell class="font-medium">
                  <a
                    class="underline-offset-4 hover:underline"
                    href={resolve("/(app)/taxes/[year]", {
                      year: String(y.year),
                    })}>{y.year}</a
                  >
                </Table.Cell>
                <Table.Cell class="hidden md:table-cell">
                  {y.authority ?? "-"}
                </Table.Cell>
                <Table.Cell class="text-end">
                  <Amount value={y.balance.paidByMe} currency={y.currency} />
                </Table.Cell>
                <Table.Cell class="hidden text-end sm:table-cell">
                  <Amount
                    value={y.balance.creditedByOffice}
                    currency={y.currency}
                  />
                </Table.Cell>
                <Table.Cell class="text-end">
                  <TaxOutcome balance={y.balance} currency={y.currency} />
                </Table.Cell>
                <Table.Cell>
                  {#if y.reconciled}
                    <Badge
                      variant="outline"
                      class="border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
                    >
                      <CircleCheckIcon /> Reconciled
                    </Badge>
                  {:else if y.discrepancies > 0}
                    <Badge
                      variant="outline"
                      class="border-destructive/40 text-destructive"
                    >
                      <TriangleAlertIcon />
                      {y.discrepancies}
                      {y.discrepancies === 1 ? "difference" : "differences"}
                    </Badge>
                  {:else}
                    <Badge variant="outline">No lines</Badge>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root>
    <Card.Header>
      <Card.Title>Add a tax year</Card.Title>
      <Card.Description>
        Enter the tax authority and, once you have it, the assessed total.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <TaxYearForm
        action="?/create"
        initialYear={data.defaultYear}
        currency={data.defaultCurrency}
        submitLabel="Add tax year"
      />
    </Card.Content>
  </Card.Root>
</div>
