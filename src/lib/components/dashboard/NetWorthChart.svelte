<script lang="ts">
  import { AreaChart } from "layerchart";
  import * as Chart from "$lib/components/ui/chart/index.js";
  import { formatDate } from "$lib/format";
  import { currencyExponent, formatAmount, type Minor } from "$lib/money";

  type Point = { date: string; amount: Minor };

  let {
    currency,
    points,
    color = "var(--color-chart-1)",
    range = "12m",
  }: {
    currency: string;
    points: Point[];
    color?: string;
    range?: string;
  } = $props();

  const exponent = $derived(currencyExponent(currency));

  // `value` exists only to position points on the numeric axis; `amount` is what gets displayed.
  const rows = $derived(
    points.map((p) => ({
      date: new Date(`${p.date}T00:00:00Z`),
      value: p.amount / 10 ** exponent,
      amount: p.amount,
    })),
  );

  const domain = $derived.by((): [number, number] => {
    const values = rows.map((r) => r.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = (max - min || Math.abs(max) || 1) * 0.15;
    return [min - pad, max + pad];
  });

  const compact = $derived(
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }),
  );

  const dateTick = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    timeZone: "UTC",
  });

  const config = $derived({
    value: { label: `Net worth ${currency}`, color },
  } satisfies Chart.ChartConfig);

  const summary = $derived.by(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return "";
    const amounts = points.map((p) => p.amount);
    const lo = Math.min(...amounts) as Minor;
    const hi = Math.max(...amounts) as Minor;
    return `Net worth in ${currency} from ${formatDate(first.date)} to ${formatDate(last.date)}: ${formatAmount(first.amount, currency)} to ${formatAmount(last.amount, currency)}, lowest ${formatAmount(lo, currency)}, highest ${formatAmount(hi, currency)}.`;
  });

  function isoOf(d: Date) {
    return d.toISOString().slice(0, 10);
  }
</script>

<p class="sr-only">{summary}</p>
<Chart.Container
  {config}
  aria-hidden="true"
  class="aspect-auto h-52 w-full sm:h-60"
>
  <AreaChart
    data={rows}
    x="date"
    y="value"
    yDomain={domain}
    series={[{ key: "value", label: config.value.label, color }]}
    padding={{ left: 48, bottom: 24, top: 8, right: 8 }}
    props={{
      area: { "fill-opacity": 0.2, line: { class: "stroke-2" } },
      xAxis: {
        ticks: 5,
        format: (v: Date) =>
          range === "3m"
            ? `${v.getUTCDate()} ${dateTick.format(v)}`
            : `${dateTick.format(v)} '${String(v.getUTCFullYear()).slice(2)}`,
      },
      yAxis: {
        ticks: 4,
        format: (v: number) => compact.format(v),
      },
    }}
  >
    {#snippet tooltip()}
      <Chart.Tooltip
        indicator="dot"
        labelFormatter={(v: Date) => formatDate(isoOf(v))}
      >
        {#snippet formatter({ item })}
          <span class="text-muted-foreground">Net worth</span>
          <span class="text-foreground ms-auto font-medium tabular-nums">
            {formatAmount(item.payload.amount as Minor, currency)}
          </span>
        {/snippet}
      </Chart.Tooltip>
    {/snippet}
  </AreaChart>
</Chart.Container>
