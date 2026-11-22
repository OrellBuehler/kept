<script lang="ts">
  import { LineChart } from "layerchart";
  import * as Card from "$lib/components/ui/card";
  import * as Chart from "$lib/components/ui/chart/index.js";
  import Amount from "$lib/components/Amount.svelte";
  import { formatReturn, PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
  import { usePreferences } from "$lib/preferences.svelte";
  import type {
    Pillar3aPortfolioOverview,
    PortfolioPerformance,
  } from "$lib/server/pillar3a";

  const prefs = usePreferences();
  const currency = PILLAR_3A_CURRENCY;

  const COLORS = [
    "var(--color-chart-1)",
    "var(--color-chart-2)",
    "var(--color-chart-3)",
    "var(--color-chart-4)",
    "var(--color-chart-5)",
  ];

  let {
    performance,
    portfolios,
  }: {
    performance: PortfolioPerformance[];
    /** In display order. */
    portfolios: Pillar3aPortfolioOverview[];
  } = $props();

  const all = $derived(
    portfolios.flatMap((p) => {
      const points =
        performance.find((x) => x.portfolioId === p.portfolioId)?.points ?? [];
      return points.length > 0 ? [{ portfolio: p, points }] : [];
    }),
  );
  // Colour by the portfolio, not by its place among those with gains: entering
  // a first gain or closing a portfolio must not repaint the others. With more
  // portfolios than colours that cannot hold, and the place decides.
  const colorIndex = $derived.by(() => {
    const ids = portfolios.map((p) => p.portfolioId).sort();
    return (id: string, place: number) =>
      ids.length <= COLORS.length ? ids.indexOf(id) : place;
  });
  const series = $derived(
    all.slice(0, COLORS.length).map((s, i) => ({
      key: `p${i}`,
      name: s.portfolio.name,
      strategy: s.portfolio.strategy,
      color: COLORS[colorIndex(s.portfolio.portfolioId, i)]!,
      points: s.points,
      last: s.points[s.points.length - 1]!,
      // Each portfolio has its own dates, so its line bridges the dates it has no entry for.
      rows: s.points.map((p) => ({
        date: dayOf(p.date),
        percent: p.gainBps / 100,
      })),
    })),
  );

  const dateCount = $derived(
    new Set(series.flatMap((s) => s.points.map((p) => p.date))).size,
  );

  const domain = $derived.by((): [number, number] => {
    const values = series.flatMap((s) => s.points.map((p) => p.gainBps / 100));
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const pad = (max - min || 1) * 0.1;
    return [min - pad, max + pad];
  });

  // A little room either side, so the first and last dots do not sit on the axes.
  const xDomain = $derived.by((): [Date, Date] => {
    const times = series.flatMap((s) => s.rows.map((r) => r.date.getTime()));
    const min = Math.min(...times);
    const max = Math.max(...times);
    const pad = (max - min) * 0.04;
    return [new Date(min - pad), new Date(max + pad)];
  });

  const config = $derived(
    Object.fromEntries(
      series.map((s) => [s.key, { label: s.name, color: s.color }]),
    ) satisfies Chart.ChartConfig,
  );

  const dateTick = $derived(
    new Intl.DateTimeFormat(prefs.locale, { month: "short" }),
  );
  const percentTick = $derived(
    new Intl.NumberFormat(prefs.locale, {
      style: "percent",
      maximumFractionDigits: 2,
    }),
  );

  const summary = $derived(
    series
      .map(
        (s) =>
          `${s.name}: ${formatReturn(s.last.gainBps, prefs.locale)} as of ${prefs.date(s.last.date)}`,
      )
      .join("; "),
  );

  // Short ranges tick by week, so only the first of a month is labelled by month alone.
  function tickLabel(v: Date) {
    return v.getDate() === 1
      ? `${dateTick.format(v)} '${String(v.getFullYear()).slice(2)}`
      : `${v.getDate()} ${dateTick.format(v)}`;
  }

  // Local midnight, so the scale's own (local) ticks and the labels agree in every timezone.
  function dayOf(iso: string) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y!, m! - 1, d);
  }

  function isoOf(d: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
</script>

{#if series.length > 0}
  <Card.Root>
    <Card.Header>
      <Card.Title>Performance</Card.Title>
      <Card.Description>
        Total return of each portfolio, from the gains entered with its values:
        your provider's percentage, or else the gain over the capital it grew
        from.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      <ul class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {#each series as s (s.key)}
          <li class="flex items-start gap-2">
            <span
              class="mt-1.5 size-2.5 shrink-0 rounded-full"
              style:background-color={s.color}
              aria-hidden="true"
            ></span>
            <div class="grid">
              <span class="font-medium break-words">{s.name}</span>
              {#if s.strategy}
                <span class="text-muted-foreground text-xs break-words">
                  {s.strategy}
                </span>
              {/if}
              <span class="tabular-nums">
                {formatReturn(s.last.gainBps, prefs.locale)}
                {#if s.last.gain !== null}
                  <span class="text-muted-foreground">·</span>
                  <Amount value={s.last.gain} {currency} flow />
                {/if}
              </span>
            </div>
          </li>
        {/each}
      </ul>
      {#if dateCount > 1}
        <p class="sr-only">Total return over time. Latest: {summary}.</p>
        <Chart.Container
          {config}
          aria-hidden="true"
          class="aspect-auto h-52 w-full sm:h-60"
        >
          <LineChart
            x="date"
            y="percent"
            {xDomain}
            yDomain={domain}
            yNice={false}
            series={series.map((s) => ({
              key: s.key,
              label: s.name,
              color: s.color,
              data: s.rows,
            }))}
            points={dateCount <= 24}
            padding={{ left: 48, bottom: 24, top: 8, right: 8 }}
            props={{
              spline: { class: "stroke-2" },
              xAxis: {
                tickOcclusion: { padding: 8 },
                format: tickLabel,
              },
              yAxis: {
                ticks: 4,
                format: (v: number) => percentTick.format(v / 100),
              },
            }}
          >
            {#snippet tooltip()}
              <Chart.Tooltip
                indicator="dot"
                class="max-w-64"
                labelFormatter={(v: Date) => prefs.date(isoOf(v))}
              >
                {#snippet formatter({ value, name, item })}
                  <span
                    class="size-2.5 shrink-0 rounded-full"
                    style:background-color={item.color}
                  ></span>
                  <span class="text-muted-foreground break-words">{name}</span>
                  <span
                    class="text-foreground ms-auto ps-3 font-medium tabular-nums"
                  >
                    {formatReturn(
                      Math.round(Number(value) * 100),
                      prefs.locale,
                    )}
                  </span>
                {/snippet}
              </Chart.Tooltip>
            {/snippet}
          </LineChart>
        </Chart.Container>
      {:else}
        <p class="text-muted-foreground text-sm">
          The chart appears once gains are entered on two different dates.
        </p>
      {/if}
      {#if all.length > series.length}
        <p class="text-muted-foreground text-xs">
          Showing the first {series.length} of {all.length} portfolios with reported
          gains.
        </p>
      {/if}
    </Card.Content>
  </Card.Root>
{/if}
