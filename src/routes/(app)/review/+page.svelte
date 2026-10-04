<script lang="ts">
  import { resolve } from "$app/paths";
  import { cn } from "$lib/utils";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { Button } from "$lib/components/ui/button";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Amount from "$lib/components/Amount.svelte";
  import SankeyChart from "$lib/components/review/SankeyChart.svelte";
  import { formatDate } from "$lib/format";
  import { formatAmount, minor } from "$lib/money";
  import CalendarRangeIcon from "@lucide/svelte/icons/calendar-range";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const review = $derived(data.review);

  const monthFormat = new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
  });
  const monthLabel = (month: string) =>
    monthFormat.format(new Date(`${month}-01T00:00:00Z`));

  const percent = new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: 0,
  });

  function barHeight(value: number, max: number) {
    return max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  }
</script>

<svelte:head>
  <title>Year in review {data.year} · Kept</title>
</svelte:head>

<PageHeader
  title="Year in review"
  description={review.partial
    ? `${data.year} so far, up to ${formatDate(review.to)}.`
    : `January to December ${data.year}.`}
  class="mb-6"
>
  {#snippet actions()}
    <nav class="flex items-center gap-1" aria-label="Year">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Previous year"
        disabled={data.year <= data.firstYear}
        href="{resolve('/(app)/review')}?year={data.year - 1}"
      >
        <ChevronLeftIcon />
      </Button>
      <span class="min-w-16 text-center text-sm font-medium">{data.year}</span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Next year"
        disabled={data.year >= data.currentYear}
        href="{resolve('/(app)/review')}?year={data.year + 1}"
      >
        <ChevronRightIcon />
      </Button>
    </nav>
  {/snippet}
</PageHeader>

<p class="text-muted-foreground mb-6 text-sm">
  Amounts are shown per currency and never converted. Transfers between your own
  accounts are left out when the counterparty IBAN matches one of your accounts{review.excludedTransfers >
  0
    ? ` (${review.excludedTransfers} left out in ${data.year})`
    : ""}. Refunds reduce the category they belong to.
</p>

{#if review.currencies.length === 0}
  <Empty.Root class="border border-dashed">
    <Empty.Header>
      <Empty.Media variant="icon"><CalendarRangeIcon /></Empty.Media>
      <Empty.Title>No transactions in {data.year}</Empty.Title>
      <Empty.Description>
        Import statements for this year to see where your money went.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <Button href={resolve("/import")}>Import a statement</Button>
    </Empty.Content>
  </Empty.Root>
{:else}
  <div class="grid gap-10">
    {#each review.currencies as c (c.currency)}
      {@const monthMax = Math.max(
        1,
        ...c.months.flatMap((m) => [m.income, m.expenses]),
      )}
      <section class="grid gap-4" aria-labelledby="review-{c.currency}">
        <h2 id="review-{c.currency}" class="text-xl font-semibold">
          {c.currency}
        </h2>

        <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Card.Root class="gap-1 py-4">
            <Card.Header class="px-4">
              <Card.Description>Income</Card.Description>
              <Card.Title class="text-lg tabular-nums">
                <Amount value={c.income} currency={c.currency} />
              </Card.Title>
            </Card.Header>
          </Card.Root>
          <Card.Root class="gap-1 py-4">
            <Card.Header class="px-4">
              <Card.Description>Expenses</Card.Description>
              <Card.Title class="text-lg tabular-nums">
                <Amount value={c.expenses} currency={c.currency} />
              </Card.Title>
            </Card.Header>
          </Card.Root>
          <Card.Root class="gap-1 py-4">
            <Card.Header class="px-4">
              <Card.Description>Net saved</Card.Description>
              <Card.Title class="text-lg tabular-nums">
                <Amount value={c.net} currency={c.currency} />
              </Card.Title>
            </Card.Header>
          </Card.Root>
          <Card.Root class="gap-1 py-4">
            <Card.Header class="px-4">
              <Card.Description>Savings rate</Card.Description>
              <Card.Title
                class={cn(
                  "text-lg tabular-nums",
                  c.savingsRate !== null &&
                    c.savingsRate < 0 &&
                    "text-destructive",
                )}
              >
                {c.savingsRate === null ? "n/a" : percent.format(c.savingsRate)}
              </Card.Title>
            </Card.Header>
          </Card.Root>
          <Card.Root class="col-span-2 gap-1 py-4 lg:col-span-1">
            <Card.Header class="px-4">
              <Card.Description>Net worth change</Card.Description>
              <Card.Title class="text-lg tabular-nums">
                {#if c.netWorth}
                  <Amount
                    value={c.netWorth.change}
                    currency={c.currency}
                    flow
                  />
                {:else}
                  n/a
                {/if}
              </Card.Title>
            </Card.Header>
          </Card.Root>
        </div>

        <Card.Root>
          <Card.Header>
            <Card.Title>Where the money went</Card.Title>
            <Card.Description>
              Income by category, flowing into expenses by category. The smaller
              categories are grouped as Other.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <SankeyChart graph={c.sankey} currency={c.currency} />
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Month by month</Card.Title>
            <Card.Description>
              <span class="inline-flex items-center gap-1">
                <span class="size-2 rounded-full bg-[var(--color-chart-1)]"
                ></span> Income
              </span>
              <span class="ms-3 inline-flex items-center gap-1">
                <span class="size-2 rounded-full bg-[var(--color-chart-5)]"
                ></span> Expenses
              </span>
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <ol class="grid grid-cols-12 gap-1">
              {#each c.months as m (m.month)}
                <li class="flex min-w-0 flex-col items-center gap-1">
                  <div
                    class="flex h-32 w-full items-end justify-center gap-0.5"
                  >
                    <div
                      class="w-full max-w-3 rounded-t bg-[var(--color-chart-1)]"
                      style:height="{barHeight(m.income, monthMax)}%"
                    ></div>
                    <div
                      class="w-full max-w-3 rounded-t bg-[var(--color-chart-5)]"
                      style:height="{barHeight(m.expenses, monthMax)}%"
                    ></div>
                  </div>
                  <span class="text-muted-foreground text-[10px] sm:text-xs">
                    {monthLabel(m.month)}
                  </span>
                  <span class="sr-only">
                    {m.month}: income {formatAmount(m.income, c.currency)},
                    expenses {formatAmount(m.expenses, c.currency)}
                  </span>
                </li>
              {/each}
            </ol>
          </Card.Content>
        </Card.Root>

        <div class="grid gap-4 lg:grid-cols-2">
          <Card.Root>
            <Card.Header>
              <Card.Title>Biggest changes</Card.Title>
              <Card.Description>
                Compared with {data.year - 1}.
              </Card.Description>
            </Card.Header>
            <Card.Content>
              {#if !c.hasPreviousYear}
                <p class="text-muted-foreground text-sm">
                  No {c.currency} transactions in {data.year - 1} to compare with.
                </p>
              {:else}
                <ul class="divide-y">
                  {#each c.changes as ch (`${ch.side}:${ch.categoryId ?? "none"}`)}
                    <li class="flex items-center justify-between gap-3 py-2">
                      <div class="min-w-0">
                        <p class="truncate text-sm font-medium">{ch.name}</p>
                        <p class="text-muted-foreground text-xs">
                          {ch.side === "income" ? "Income" : "Expense"}
                          {#if ch.changePct !== null}
                            · {ch.change > 0 ? "+" : ""}{percent.format(
                              ch.changePct,
                            )}
                          {:else}
                            · new
                          {/if}
                        </p>
                      </div>
                      <Amount
                        value={ch.change}
                        currency={c.currency}
                        class={cn(
                          "text-sm",
                          ch.change < 0 && "text-foreground",
                        )}
                      />
                    </li>
                  {/each}
                </ul>
              {/if}
            </Card.Content>
          </Card.Root>

          <Card.Root>
            <Card.Header>
              <Card.Title>Top counterparties by spend</Card.Title>
            </Card.Header>
            <Card.Content>
              {#if c.counterparties.length === 0}
                <p class="text-muted-foreground text-sm">
                  No expenses with a counterparty name.
                </p>
              {:else}
                <ul class="divide-y">
                  {#each c.counterparties as p (p.name)}
                    <li class="flex items-center justify-between gap-3 py-2">
                      <div class="min-w-0">
                        <p class="truncate text-sm font-medium">{p.name}</p>
                        <p class="text-muted-foreground text-xs">
                          {p.count}
                          {p.count === 1 ? "payment" : "payments"}
                        </p>
                      </div>
                      <Amount
                        value={minor(p.spent)}
                        currency={c.currency}
                        class="text-foreground text-sm"
                      />
                    </li>
                  {/each}
                </ul>
              {/if}
            </Card.Content>
          </Card.Root>
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          {#each [{ title: "Largest expenses", list: c.largestExpenses }, { title: "Largest income", list: c.largestIncome }] as group (group.title)}
            <Card.Root>
              <Card.Header>
                <Card.Title>{group.title}</Card.Title>
              </Card.Header>
              <Card.Content>
                {#if group.list.length === 0}
                  <p class="text-muted-foreground text-sm">None.</p>
                {:else}
                  <ul class="divide-y">
                    {#each group.list as t (t.id)}
                      <li class="flex items-center justify-between gap-3 py-2">
                        <div class="min-w-0">
                          <p class="truncate text-sm font-medium">
                            {t.counterparty ?? "No counterparty"}
                          </p>
                          <p class="text-muted-foreground text-xs">
                            {formatDate(t.bookingDate)}{t.categoryName
                              ? ` · ${t.categoryName}`
                              : ""}
                          </p>
                        </div>
                        <Amount
                          value={t.amount}
                          currency={c.currency}
                          flow
                          class="text-sm"
                        />
                      </li>
                    {/each}
                  </ul>
                {/if}
              </Card.Content>
            </Card.Root>
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}
