<script lang="ts">
  import { currencyExponent, formatAmount, minor } from "$lib/money";
  import { layoutSankey, type LaidNode, type SankeyGraph } from "$lib/sankey";

  let { graph, currency }: { graph: SankeyGraph; currency: string } = $props();

  const MARGIN = { left: 150, right: 150, top: 8, bottom: 8 };
  const WIDTH = 780;

  const rows = $derived(Math.max(graph.left.length, graph.right.length, 1));
  const height = $derived(Math.max(260, rows * 34));
  const layout = $derived(
    layoutSankey(graph, {
      width: WIDTH - MARGIN.left - MARGIN.right,
      height: height - MARGIN.top - MARGIN.bottom,
      gap: 18,
    }),
  );

  const compact = $derived(
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }),
  );
  const exponent = $derived(currencyExponent(currency));

  function color(n: LaidNode) {
    if (n.kind === "income") return "var(--color-chart-1)";
    if (n.kind === "saved") return "var(--color-chart-2)";
    if (n.kind === "deficit") return "var(--color-chart-3)";
    if (n.kind === "expense") return n.color ?? "var(--color-chart-5)";
    return "var(--color-muted-foreground)";
  }

  function money(value: number) {
    return formatAmount(minor(value), currency);
  }

  function short(label: string) {
    return label.length > 18 ? `${label.slice(0, 17)}…` : label;
  }

  const summary = $derived(
    [...graph.left, ...(graph.total ? [graph.total] : []), ...graph.right]
      .map((n) => `${n.label}: ${money(n.value)}`)
      .join("; "),
  );
</script>

<div class="overflow-x-auto">
  <svg
    viewBox="0 0 {WIDTH} {height}"
    class="h-auto w-full min-w-[640px]"
    role="img"
    aria-label="Where income came from and where it went, in {currency}. {summary}"
  >
    <g transform="translate({MARGIN.left},{MARGIN.top})">
      {#each layout.links as link (link.id)}
        <path
          d={link.path}
          fill="none"
          stroke={color(link.colorNode)}
          stroke-width={Math.max(link.strokeWidth, 1)}
          stroke-opacity="0.3"
        >
          <title>
            {link.colorNode.label}: {money(link.value)}
          </title>
        </path>
      {/each}
      {#each layout.nodes as n (n.id)}
        <rect
          x={n.x}
          y={n.y}
          width={n.width}
          height={Math.max(n.height, 1)}
          rx="2"
          fill={color(n)}
        >
          <title>{n.label}: {money(n.value)}</title>
        </rect>
        {#if n.column === 1}
          <text
            x={n.x + n.width / 2}
            y={n.y - 4}
            text-anchor="middle"
            class="fill-foreground text-[11px] font-medium"
          >
            {compact.format(n.value / 10 ** exponent)}
          </text>
        {:else}
          <text
            x={n.column === 0 ? n.x - 6 : n.x + n.width + 6}
            y={n.y + n.height / 2}
            dominant-baseline="middle"
            text-anchor={n.column === 0 ? "end" : "start"}
            class="fill-foreground text-[11px]"
          >
            {short(n.label)}
            <tspan class="fill-muted-foreground">
              {compact.format(n.value / 10 ** exponent)}
            </tspan>
          </text>
        {/if}
      {/each}
    </g>
  </svg>
</div>
