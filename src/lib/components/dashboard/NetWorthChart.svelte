<script lang="ts">
  import { Area, AreaChart, LinearGradient } from "layerchart";
  import * as Chart from "$lib/components/ui/chart/index.js";
  import { currencyExponent, type Minor } from "$lib/money";
  import { cn } from "$lib/utils";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  type Point = { date: string; amount: Minor };

  let {
    currency,
    points,
    color = "var(--color-chart-1)",
    range = "12m",
    label = "Net worth",
  }: {
    currency: string;
    points: Point[];
    color?: string;
    range?: string;
    label?: string;
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
    new Intl.NumberFormat(prefs.locale, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }),
  );

  const dateTick = $derived(
    new Intl.DateTimeFormat(prefs.locale, {
      month: "short",
      timeZone: "UTC",
    }),
  );

  const config = $derived({
    value: { label: `${label} ${currency}`, color },
  } satisfies Chart.ChartConfig);

  const summary = $derived.by(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return "";
    const amounts = points.map((p) => p.amount);
    const lo = Math.min(...amounts) as Minor;
    const hi = Math.max(...amounts) as Minor;
    return `${label} in ${currency} from ${prefs.date(first.date)} to ${prefs.date(last.date)}: ${prefs.amount(first.amount, currency)} to ${prefs.amount(last.amount, currency)}, lowest ${prefs.amount(lo, currency)}, highest ${prefs.amount(hi, currency)}.`;
  });

  function isoOf(d: Date) {
    return d.toISOString().slice(0, 10);
  }
</script>

<p class="sr-only">{summary}</p>
<Chart.Container
  {config}
  aria-hidden="true"
  class={cn(
    "aspect-auto h-52 w-full sm:h-60",
    // Depends on layerchart's internal class names (.lc-axis.placement-left, .lc-text-svg); recheck after upgrading it.
    prefs.blur && "[&_.lc-axis.placement-left_.lc-text-svg]:blur-sm",
  )}
>
  <AreaChart
    data={rows}
    x="date"
    y="value"
    yDomain={domain}
    series={[{ key: "value", label: config.value.label, color }]}
    padding={{ left: 64, bottom: 24, top: 8, right: 8 }}
    props={{
      area: { line: { class: "stroke-2" } },
      xAxis: {
        ticks: 5,
        format: (v: Date) =>
          range === "3m" || range === "days"
            ? `${v.getUTCDate()} ${dateTick.format(v)}`
            : `${dateTick.format(v)} '${String(v.getUTCFullYear()).slice(2)}`,
      },
      yAxis: {
        ticks: 4,
        format: (v: number) => compact.format(v),
      },
    }}
  >
    {#snippet marks({ getAreaProps })}
      <LinearGradient vertical>
        {#snippet stopsContent()}
          <stop offset="0%" stop-color={color} stop-opacity="0.4" />
          <stop offset="100%" stop-color={color} stop-opacity="0" />
        {/snippet}
        {#snippet children({ gradient })}
          <Area
            {...getAreaProps(
              { key: "value", label: config.value.label, color },
              0,
            )}
            fill={gradient}
            fillOpacity={1}
          />
        {/snippet}
      </LinearGradient>
    {/snippet}
    {#snippet tooltip()}
      <Chart.Tooltip
        indicator="dot"
        labelFormatter={(v: Date) => prefs.date(isoOf(v))}
      >
        {#snippet formatter({ item })}
          <span class="text-muted-foreground">{label}</span>
          <span
            class={cn(
              "text-foreground ms-auto font-medium tabular-nums",
              prefs.blur && "blur-sm select-none",
            )}
          >
            {prefs.amount(item.payload.amount as Minor, currency)}
          </span>
        {/snippet}
      </Chart.Tooltip>
    {/snippet}
  </AreaChart>
</Chart.Container>
