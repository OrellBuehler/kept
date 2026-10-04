<script lang="ts">
  import InstitutionLogo from "$lib/components/InstitutionLogo.svelte";
  import { resolve } from "$app/paths";
  import { cn } from "$lib/utils";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import PageHeader from "$lib/components/app/page-header.svelte";
  import Amount from "$lib/components/Amount.svelte";
  import AccountTypeBadge from "$lib/components/AccountTypeBadge.svelte";
  import CategoryBadge from "$lib/components/CategoryBadge.svelte";
  import ShareBadge from "$lib/components/ShareBadge.svelte";
  import NetWorthChart from "$lib/components/dashboard/NetWorthChart.svelte";

  import {
    FULL_SHARE_BPS,
    minor,
    type Minor,
    type ShareBasis,
  } from "$lib/money";
  import LayoutDashboardIcon from "@lucide/svelte/icons/layout-dashboard";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import MinusIcon from "@lucide/svelte/icons/minus";
  import type { PageProps } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let { data }: PageProps = $props();
  const d = $derived(data.dashboard);

  const BASES = [
    { value: "total", label: "Total" },
    { value: "share", label: "My share" },
  ] as const;

  let netBasis = $state<ShareBasis>("total");
  let spendBasis = $state<ShareBasis>("share");

  const netSeries = $derived(
    netBasis === "share" && d.netWorth.shareSeries
      ? d.netWorth.shareSeries
      : d.netWorth.series,
  );
  const spendingView = $derived(
    spendBasis === "total" && d.spendingTotal ? d.spendingTotal : d.spending,
  );

  const RANGES = [
    { value: "3m", label: "3M" },
    { value: "6m", label: "6M" },
    { value: "12m", label: "12M" },
    { value: "all", label: "All" },
  ] as const;

  function monthLabel(month: string) {
    return prefs.month(month);
  }
  function monthName(month: string) {
    return prefs.month(month, "long", false);
  }

  function plural(n: number, one: string, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
  }

  const DAY_MS = 86_400_000;
  function daysBetween(fromIso: string, toIso: string) {
    return Math.round(
      (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) /
        DAY_MS,
    );
  }

  const chartColors = [
    "var(--color-chart-1)",
    "var(--color-chart-2)",
    "var(--color-chart-3)",
    "var(--color-chart-4)",
  ];

  const sortedAccounts = $derived(
    [...d.accounts].sort(
      (a, b) =>
        (a.institution?.name ?? "￿").localeCompare(
          b.institution?.name ?? "￿",
        ) || a.name.localeCompare(b.name),
    ),
  );

  const lastRowStart = $derived(
    sortedAccounts.length - (sortedAccounts.length % 2 === 0 ? 2 : 1),
  );

  const monthRows = $derived(
    d.month.totals.map((t, i) => ({
      currency: t.currency,
      prev: d.month.previousTotals[i],
      cur: t,
    })),
  );

  const shareRows = $derived(
    d.shareMonth
      ? d.shareMonth.totals.map((t) => ({
          currency: t.currency,
          cur: t,
          total: d.netWorth.totals.find((n) => n.currency === t.currency),
        }))
      : [],
  );
  const shareTotals = $derived(
    d.netWorth.totals.filter((t) => t.shareBalance !== t.balance),
  );

  function delta(cur: number, prev: number) {
    return { diff: cur - prev };
  }

  const bucketRows = $derived([
    {
      key: "overdue",
      label: "Overdue",
      bucket: d.bills.overdue,
      tone: "destructive",
    },
    {
      key: "dueSoon",
      label: "Due soon",
      bucket: d.bills.dueSoon,
      tone: "default",
    },
    {
      key: "awaitingRefund",
      label: "Awaiting refund",
      bucket: d.bills.awaitingRefund,
      tone: "default",
    },
  ]);

  function staleText(a: (typeof d.accounts)[number]) {
    if (a.lastImportAt !== null && a.staleDays !== null) {
      return `Last import ${plural(a.staleDays, "day")} ago`;
    }
    if (a.lastSnapshotDate) {
      return `Last snapshot ${plural(daysBetween(a.lastSnapshotDate, d.today), "day")} ago`;
    }
    return "No recent data";
  }
</script>

<svelte:head>
  <title>Dashboard · Kept</title>
</svelte:head>

<PageHeader
  title="Dashboard"
  description={`Where things stand on ${prefs.date(d.today)}.`}
  class="mb-6"
/>

{#if d.accounts.length === 0}
  <Empty.Root class="border border-dashed">
    <Empty.Header>
      <Empty.Media variant="icon"><LayoutDashboardIcon /></Empty.Media>
      <Empty.Title>Nothing to show yet</Empty.Title>
      <Empty.Description>
        Add an account first. Then import a statement and add the bills you want
        to keep track of, and your dashboard fills in.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <div class="flex flex-wrap justify-center gap-2">
        <Button href={resolve("/accounts")}>Go to accounts</Button>
        <Button variant="outline" href={resolve("/import")}>
          Import a statement
        </Button>
        <Button variant="outline" href={resolve("/bills/new")}>
          Add a bill
        </Button>
      </div>
    </Empty.Content>
  </Empty.Root>
{:else}
  <div class="grid gap-4 lg:grid-cols-2">
    <Card.Root class="surface-hero shadow-raised overflow-hidden lg:col-span-2">
      <Card.Header>
        <Card.Title>Net worth</Card.Title>
        <Card.Description>
          Per currency, never converted between currencies.
          {#if d.hasShared}
            {netBasis === "share"
              ? "Shared accounts counted at your share."
              : "All accounts in full."}
          {/if}
        </Card.Description>
        <Card.Action class="flex flex-wrap justify-end gap-2">
          {#if d.hasShared}
            <div
              class="bg-muted inline-flex rounded-lg p-0.5"
              role="group"
              aria-label="Net worth basis"
            >
              {#each BASES as b (b.value)}
                <button
                  type="button"
                  aria-pressed={netBasis === b.value}
                  onclick={() => (netBasis = b.value)}
                  class={cn(
                    "focus-visible:ring-ring/50 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
                    netBasis === b.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}>{b.label}</button
                >
              {/each}
            </div>
          {/if}
          <nav
            class="bg-muted inline-flex rounded-lg p-0.5"
            aria-label="Chart range"
          >
            {#each RANGES as r (r.value)}
              <a
                href="{resolve('/(app)')}?range={r.value}"
                data-sveltekit-noscroll
                aria-current={d.range === r.value ? "page" : undefined}
                class={cn(
                  "focus-visible:ring-ring/50 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
                  d.range === r.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}>{r.label}</a
              >
            {/each}
          </nav>
        </Card.Action>
      </Card.Header>
      <Card.Content class="space-y-8">
        {#each d.netWorth.totals as total, i (total.currency)}
          {@const series = netSeries.find((s) => s.currency === total.currency)}
          <section
            aria-label={`Net worth ${total.currency}`}
            class="not-first:border-t not-first:pt-6"
          >
            <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Amount
                value={netBasis === "share"
                  ? total.shareBalance
                  : total.balance}
                currency={total.currency}
                class="text-4xl font-semibold tracking-tight"
              />
              <span class="text-muted-foreground text-sm">
                {plural(total.accountCount, "account")}
              </span>
            </div>
            {#if series && series.points.length > 1}
              <NetWorthChart
                currency={total.currency}
                points={series.points}
                range={d.range}
                color={chartColors[i % chartColors.length]}
              />
            {:else}
              <p class="text-muted-foreground text-sm">
                Not enough history yet to draw a chart.
              </p>
            {/if}
          </section>
        {:else}
          <p class="text-muted-foreground text-sm">
            No active accounts to total up.
          </p>
        {/each}
      </Card.Content>
    </Card.Root>

    {#if d.hasShared && d.shareMonth}
      <Card.Root class="lg:col-span-2">
        <Card.Header>
          <Card.Title>My share</Card.Title>
          <Card.Description>
            Shared accounts counted at your ownership share. The other cards
            show full amounts.
          </Card.Description>
        </Card.Header>
        <Card.Content class="grid gap-6 sm:grid-cols-2">
          <section aria-label="Net worth at my share" class="space-y-3">
            <h3 class="text-sm font-medium">Net worth</h3>
            {#each d.netWorth.totals as total (total.currency)}
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-muted-foreground text-sm">
                  {total.currency}
                </span>
                <span class="text-end">
                  <Amount
                    value={total.shareBalance}
                    currency={total.currency}
                    class="text-2xl font-semibold"
                  />
                  {#if shareTotals.includes(total)}
                    <span class="text-muted-foreground block text-xs">
                      of <Amount
                        value={total.balance}
                        currency={total.currency}
                      /> in full
                    </span>
                  {/if}
                </span>
              </div>
            {/each}
          </section>
          <section aria-label="This month at my share" class="space-y-3">
            <h3 class="text-sm font-medium">
              {monthLabel(d.shareMonth.month)}
            </h3>
            {#each shareRows as row (row.currency)}
              <div>
                {#if shareRows.length > 1}
                  <p class="text-muted-foreground mb-1 text-xs font-medium">
                    {row.currency}
                  </p>
                {/if}
                <dl class="space-y-1.5 text-sm">
                  <div class="flex items-baseline justify-between gap-3">
                    <dt class="text-muted-foreground">Income</dt>
                    <dd>
                      <Amount value={row.cur.income} currency={row.currency} />
                    </dd>
                  </div>
                  <div class="flex items-baseline justify-between gap-3">
                    <dt class="text-muted-foreground">Expenses</dt>
                    <dd>
                      <Amount
                        value={minor(
                          row.cur.expenses === 0 ? 0 : -row.cur.expenses,
                        )}
                        currency={row.currency}
                      />
                    </dd>
                  </div>
                  <div
                    class="flex items-baseline justify-between gap-3 border-t pt-1.5 font-medium"
                  >
                    <dt class="text-muted-foreground">Net</dt>
                    <dd>
                      <Amount
                        value={row.cur.net}
                        currency={row.currency}
                        flow
                      />
                    </dd>
                  </div>
                </dl>
              </div>
            {:else}
              <p class="text-muted-foreground text-sm">
                No transactions this month.
              </p>
            {/each}
          </section>
        </Card.Content>
      </Card.Root>
    {/if}

    {#if data.forecastAlerts.length > 0}
      <Card.Root class="border-destructive/50 lg:col-span-2">
        <Card.Header>
          <Card.Title class="text-destructive flex items-center gap-2">
            <TriangleAlertIcon class="size-4" aria-hidden="true" />
            Balance forecast
          </Card.Title>
          <Card.Description>
            Expected to go below zero within 30 days.
          </Card.Description>
          <Card.Action>
            <Button variant="outline" size="sm" href={resolve("/forecast")}>
              View forecast
            </Button>
          </Card.Action>
        </Card.Header>
        <Card.Content>
          <ul class="space-y-1.5 text-sm">
            {#each data.forecastAlerts as alert (alert.accountId)}
              <li>
                <span class="font-medium">{alert.name}</span>
                on {prefs.date(alert.date)}, to
                <Amount value={alert.balance} currency={alert.currency} />
              </li>
            {/each}
          </ul>
        </Card.Content>
      </Card.Root>
    {/if}

    <Card.Root>
      <Card.Header>
        <Card.Title>This month</Card.Title>
        <Card.Description>
          {monthLabel(d.month.month)}, compared with {monthName(
            d.month.previousMonth,
          )}{d.hasShared ? ". All accounts in full." : ""}
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-5">
        {#each monthRows as row (row.currency)}
          {@const lines = [
            {
              label: "Income",
              cur: row.cur.income,
              prev: row.prev.income,
              good: true,
            },
            {
              label: "Expenses",
              cur: row.cur.expenses,
              prev: row.prev.expenses,
              good: false,
            },
            {
              label: "Net",
              cur: row.cur.net,
              prev: row.prev.net,
              good: true,
            },
          ]}
          <div>
            {#if monthRows.length > 1}
              <p class="text-muted-foreground mb-1 text-xs font-medium">
                {row.currency}
              </p>
            {/if}
            <dl class="space-y-2">
              {#each lines as line (line.label)}
                {@const dl = delta(line.cur, line.prev)}
                <div
                  class={cn(
                    "flex items-baseline justify-between gap-3",
                    line.label === "Net" && "border-t pt-2 font-medium",
                  )}
                >
                  <dt class="text-muted-foreground text-sm">{line.label}</dt>
                  <dd class="flex flex-col items-end">
                    <span class="tabular-nums">
                      {#if line.label === "Expenses"}
                        <Amount
                          value={minor(line.cur === 0 ? 0 : -line.cur)}
                          currency={row.currency}
                        />
                      {:else}
                        <Amount
                          value={line.cur as Minor}
                          currency={row.currency}
                          flow={line.label === "Net"}
                        />
                      {/if}
                    </span>
                    <span
                      class={cn(
                        "text-muted-foreground inline-flex items-center gap-0.5 text-xs tabular-nums",
                        line.label === "Net" &&
                          dl.diff > 0 &&
                          "text-emerald-600 dark:text-emerald-400",
                        line.label === "Net" &&
                          dl.diff < 0 &&
                          "text-destructive",
                      )}
                    >
                      {#if dl.diff === 0}
                        <MinusIcon class="size-3" aria-hidden="true" />
                        same as last month
                      {:else}
                        {#if dl.diff > 0}
                          <ArrowUpIcon class="size-3" aria-hidden="true" />
                        {:else}
                          <ArrowDownIcon class="size-3" aria-hidden="true" />
                        {/if}
                        <Amount
                          value={minor(Math.abs(dl.diff))}
                          currency={row.currency}
                        />
                        {dl.diff > 0 ? "more" : "less"} than last month
                      {/if}
                    </span>
                  </dd>
                </div>
              {/each}
            </dl>
          </div>
        {:else}
          <p class="text-muted-foreground text-sm">
            No transactions this month or last month.
          </p>
        {/each}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Bills</Card.Title>
        <Card.Description>What needs attention.</Card.Description>
        <Card.Action>
          <Button variant="ghost" size="sm" href={resolve("/bills")}>
            All bills
          </Button>
        </Card.Action>
      </Card.Header>
      <Card.Content class="space-y-4">
        <ul class="space-y-2">
          {#each bucketRows as row (row.key)}
            {@const isAlert =
              row.tone === "destructive" && row.bucket.count > 0}
            <li
              class={cn(
                "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                isAlert && "border-destructive/50 bg-destructive/5",
              )}
            >
              <div class="min-w-0">
                <a
                  href={resolve("/bills")}
                  class={cn(
                    "text-sm font-medium hover:underline",
                    isAlert && "text-destructive",
                  )}>{row.label}</a
                >
                <p class="text-muted-foreground text-xs">
                  {plural(row.bucket.count, "bill")}
                  {#if row.bucket.openAmountCount > 0}
                    , {row.bucket.openAmountCount} without amount
                  {/if}
                </p>
              </div>
              <div class="flex flex-col items-end text-sm">
                {#each row.bucket.totals as t (t.currency)}
                  {#if t.amount !== 0 || row.bucket.totals.length === 1}
                    <Amount
                      value={t.amount}
                      currency={t.currency}
                      class={cn(isAlert && "text-destructive font-medium")}
                    />
                  {/if}
                {/each}
              </div>
            </li>
          {/each}
        </ul>

        <div>
          <h3 class="mb-2 text-sm font-medium">Upcoming</h3>
          {#if d.bills.upcoming.length === 0}
            <p class="text-muted-foreground text-sm">No upcoming bills.</p>
          {:else}
            <ul class="divide-y">
              {#each d.bills.upcoming as bill (bill.id)}
                {@const amount = bill.remaining ?? bill.amount}
                <li class="flex items-center justify-between gap-3 py-2">
                  <div class="min-w-0">
                    <a
                      href={resolve("/(app)/bills/[id]", { id: bill.id })}
                      class="block truncate text-sm hover:underline"
                    >
                      {bill.creditorName}
                    </a>
                    <p class="text-muted-foreground text-xs">
                      {#if bill.dueDate === null || bill.dueInDays === null}
                        No due date
                      {:else if bill.dueInDays === 0}
                        Due today
                      {:else}
                        Due in {plural(bill.dueInDays, "day")}
                        <span class="hidden sm:inline">
                          ({prefs.date(bill.dueDate)})
                        </span>
                      {/if}
                    </p>
                  </div>
                  {#if amount !== null}
                    <Amount
                      value={amount}
                      currency={bill.currency}
                      class="text-sm"
                    />
                  {:else}
                    <span class="text-muted-foreground text-sm">Open</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        {#if d.bills.unmatchedSuggestions > 0}
          <a
            href={resolve("/bills")}
            class="hover:bg-accent flex items-center justify-between rounded-md border px-3 py-2 text-sm"
          >
            <span>Payment matches waiting for confirmation</span>
            <Badge variant="secondary">{d.bills.unmatchedSuggestions}</Badge>
          </a>
        {/if}

        {#if d.unmatched.count > 0}
          <a
            href={resolve("/bills")}
            class="hover:bg-accent flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <TriangleAlertIcon
              class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <span>
              {plural(d.unmatched.count, "payment")} with a QR reference in the last
              {d.unmatched.days} days
              {d.unmatched.count === 1 ? "isn't" : "aren't"} linked to a bill.
            </span>
          </a>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>Spending by category</Card.Title>
        <Card.Description>
          {monthLabel(spendingView.month)}, per currency.
          {#if d.hasShared}
            {spendBasis === "share"
              ? "Shared accounts counted at your share."
              : "All accounts in full."}
          {/if}
        </Card.Description>
        <Card.Action class="flex flex-wrap justify-end gap-2">
          {#if d.hasShared}
            <div
              class="bg-muted inline-flex rounded-lg p-0.5"
              role="group"
              aria-label="Spending basis"
            >
              {#each [...BASES].reverse() as b (b.value)}
                <button
                  type="button"
                  aria-pressed={spendBasis === b.value}
                  onclick={() => (spendBasis = b.value)}
                  class={cn(
                    "focus-visible:ring-ring/50 rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
                    spendBasis === b.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}>{b.label}</button
                >
              {/each}
            </div>
          {/if}
          <Button variant="ghost" size="sm" href={resolve("/(app)/budgets")}>
            Budgets
          </Button>
        </Card.Action>
      </Card.Header>
      <Card.Content class="space-y-5">
        {#each spendingView.currencies as spending (spending.currency)}
          <section aria-label={`Spending ${spending.currency}`}>
            <div class="mb-2 flex items-baseline justify-between gap-3">
              <p class="text-muted-foreground text-xs font-medium">
                {spending.currency}
              </p>
              <Amount
                value={spending.total}
                currency={spending.currency}
                class="text-sm font-medium"
              />
            </div>
            <ul class="space-y-2">
              {#each spending.items.slice(0, 8) as item (item.categoryId)}
                <li>
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <CategoryBadge
                      name={item.name}
                      color={item.color}
                      icon={item.icon}
                    />
                    <Amount value={item.spent} currency={spending.currency} />
                  </div>
                  <div class="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
                    <div
                      class="bg-primary h-full rounded-full"
                      style:width="{Math.max(
                        2,
                        Math.round((item.spent / spending.total) * 100),
                      )}%"
                      style:background-color={item.color}
                    ></div>
                  </div>
                </li>
              {/each}
            </ul>
            {#if spending.items.length > 8}
              <p class="text-muted-foreground mt-2 text-xs">
                and {spending.items.length - 8} more
              </p>
            {/if}
          </section>
        {:else}
          <p class="text-muted-foreground text-sm">
            No categorized spending this month.
            <a
              href={resolve("/(app)/settings/categories")}
              class="text-primary underline-offset-2 hover:underline"
              >Set up categories</a
            >
          </p>
        {/each}
        {#if spendingView.uncategorizedCount > 0}
          <p class="text-muted-foreground text-xs">
            {plural(spendingView.uncategorizedCount, "expense")} this month
            {spendingView.uncategorizedCount === 1 ? "has" : "have"} no category.
          </p>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>Accounts</Card.Title>
        <Card.Description>Current balance per account.</Card.Description>
        <Card.Action>
          <Button variant="ghost" size="sm" href={resolve("/accounts")}>
            Manage
          </Button>
        </Card.Action>
      </Card.Header>
      <Card.Content>
        <ul class="grid gap-x-8 lg:grid-cols-2">
          {#each sortedAccounts as a, i (a.id)}
            <li
              class={cn(
                "border-b py-3",
                i === sortedAccounts.length - 1
                  ? "border-b-0"
                  : i >= lastRowStart && "lg:border-b-0",
              )}
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{a.name}</p>
                  <div
                    class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                  >
                    {#if a.institution}
                      <InstitutionLogo institution={a.institution} size="sm" />
                      <span class="truncate">{a.institution.name}</span>
                    {/if}
                    <AccountTypeBadge type={a.type} />
                    <ShareBadge
                      shareBps={a.shareBps}
                      sharedWith={a.sharedWith}
                    />
                  </div>
                </div>
                <div class="text-end">
                  {#if a.noData}
                    <span class="text-muted-foreground text-sm">
                      No data yet
                    </span>
                  {:else}
                    <Amount
                      value={a.balance}
                      currency={a.currency}
                      class="text-sm font-medium"
                    />
                    {#if a.shareBps < FULL_SHARE_BPS}
                      <p class="text-muted-foreground text-xs">
                        My share
                        <Amount value={a.shareBalance} currency={a.currency} />
                      </p>
                    {/if}
                  {/if}
                </div>
              </div>
              {#if a.noData}
                <p class="mt-1.5 text-xs">
                  <a
                    href="{resolve('/(app)/import')}?account={a.id}"
                    class="text-primary underline-offset-2 hover:underline"
                    >Import a statement</a
                  >
                </p>
              {:else if a.stale}
                <p
                  class="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                >
                  <TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {staleText(a)}.
                    <a
                      href="{resolve('/(app)/import')}?account={a.id}"
                      class="underline underline-offset-2"
                      >Import a new statement</a
                    >
                  </span>
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      </Card.Content>
    </Card.Root>
  </div>
{/if}
