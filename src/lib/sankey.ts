export type SankeyKind =
  | "income"
  | "expense"
  | "other"
  | "uncategorized"
  | "saved"
  | "deficit"
  | "total";

export interface SankeyItem {
  key: string;
  label: string;
  color: string | null;
  /** Positive minor units. */
  amount: number;
  uncategorized?: boolean;
}

export interface SankeyNode {
  id: string;
  label: string;
  /** Positive minor units. */
  value: number;
  color: string | null;
  kind: SankeyKind;
  /** 0 = sources, 1 = total, 2 = destinations. */
  column: 0 | 1 | 2;
}

export interface SankeyGraph {
  left: SankeyNode[];
  total: SankeyNode | null;
  right: SankeyNode[];
}

export interface SankeyOptions {
  maxIncome?: number;
  maxExpense?: number;
}

function side(
  items: SankeyItem[],
  max: number,
  kind: "income" | "expense",
  column: 0 | 2,
): SankeyNode[] {
  const positive = items.filter((i) => i.amount > 0);
  const named = positive
    .filter((i) => !i.uncategorized)
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  const uncategorized = positive.filter((i) => i.uncategorized);
  let shown = named.slice(0, max);
  let rest = named.slice(max);
  if (rest.length === 1) {
    shown = named;
    rest = [];
  }
  const nodes: SankeyNode[] = shown.map((i) => ({
    id: `${kind}:${i.key}`,
    label: i.label,
    value: i.amount,
    color: i.color,
    kind,
    column,
  }));
  if (rest.length > 0) {
    nodes.push({
      id: `${kind}:other`,
      label: "Other",
      value: rest.reduce((s, i) => s + i.amount, 0),
      color: null,
      kind: "other",
      column,
    });
  }
  const u = uncategorized.reduce((s, i) => s + i.amount, 0);
  if (u > 0) {
    nodes.push({
      id: `${kind}:uncategorized`,
      label: "Uncategorized",
      value: u,
      color: null,
      kind: "uncategorized",
      column,
    });
  }
  return nodes;
}

/**
 * Income categories → total → expense categories. The `max*` biggest named
 * categories per side are kept, the rest is grouped as "Other"; uncategorized
 * amounts always get their own node. Surplus becomes a "Saved" node on the
 * right, a shortfall a "From savings" node on the left, so both sides add up.
 */
export function buildSankeyGraph(
  income: SankeyItem[],
  expenses: SankeyItem[],
  { maxIncome = 5, maxExpense = 8 }: SankeyOptions = {},
): SankeyGraph {
  const left = side(income, maxIncome, "income", 0);
  const right = side(expenses, maxExpense, "expense", 2);
  const inSum = left.reduce((s, n) => s + n.value, 0);
  const outSum = right.reduce((s, n) => s + n.value, 0);
  if (inSum > outSum) {
    right.push({
      id: "saved",
      label: "Saved",
      value: inSum - outSum,
      color: null,
      kind: "saved",
      column: 2,
    });
  } else if (outSum > inSum) {
    left.push({
      id: "deficit",
      label: "From savings",
      value: outSum - inSum,
      color: null,
      kind: "deficit",
      column: 0,
    });
  }
  const total = Math.max(inSum, outSum);
  if (total === 0) return { left: [], total: null, right: [] };
  return {
    left,
    total: {
      id: "total",
      label: "Total",
      value: total,
      color: null,
      kind: "total",
      column: 1,
    },
    right,
  };
}

export interface LaidNode extends SankeyNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidLink {
  id: string;
  source: string;
  target: string;
  value: number;
  /** Cubic bezier centre line; draw it with `strokeWidth` as a ribbon. */
  path: string;
  strokeWidth: number;
  /** The outer node, whose colour the ribbon takes. */
  colorNode: LaidNode;
}

export interface SankeyLayout {
  nodes: LaidNode[];
  links: LaidLink[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  nodeWidth?: number;
  gap?: number;
}

/**
 * Three-column layout in a `width` x `height` box. Every column uses the same
 * scale and is centred vertically, so ribbon thickness is comparable.
 */
export function layoutSankey(
  graph: SankeyGraph,
  { width, height, nodeWidth = 12, gap = 10 }: LayoutOptions,
): SankeyLayout {
  const { total } = graph;
  if (!total) return { nodes: [], links: [] };
  const columns = [graph.left, [total], graph.right];
  const k = Math.min(
    ...columns.map(
      (c) =>
        (height - gap * (c.length - 1)) / c.reduce((s, n) => s + n.value, 0),
    ),
  );
  const xs = [0, (width - nodeWidth) / 2, width - nodeWidth];
  const laid = new Map<string, LaidNode>();
  columns.forEach((col, ci) => {
    const used =
      col.reduce((s, n) => s + n.value * k, 0) + gap * (col.length - 1);
    let y = (height - used) / 2;
    for (const n of col) {
      const h = n.value * k;
      laid.set(n.id, { ...n, x: xs[ci]!, y, width: nodeWidth, height: h });
      y += h + gap;
    }
  });

  const mid = laid.get(total.id)!;
  const links: LaidLink[] = [];
  const ribbon = (
    id: string,
    from: LaidNode,
    to: LaidNode,
    value: number,
    y0: number,
    y1: number,
    colorNode: LaidNode,
  ) => {
    const h = value * k;
    const x0 = from.x + from.width;
    const x1 = to.x;
    const xm = (x0 + x1) / 2;
    const c0 = y0 + h / 2;
    const c1 = y1 + h / 2;
    links.push({
      id,
      source: from.id,
      target: to.id,
      value,
      path: `M${x0},${c0} C${xm},${c0} ${xm},${c1} ${x1},${c1}`,
      strokeWidth: h,
      colorNode,
    });
  };
  let inY = mid.y;
  for (const n of graph.left) {
    const from = laid.get(n.id)!;
    ribbon(`${n.id}>total`, from, mid, n.value, from.y, inY, from);
    inY += n.value * k;
  }
  let outY = mid.y;
  for (const n of graph.right) {
    const to = laid.get(n.id)!;
    ribbon(`total>${n.id}`, mid, to, n.value, outY, to.y, to);
    outY += n.value * k;
  }
  return { nodes: [...laid.values()], links };
}
