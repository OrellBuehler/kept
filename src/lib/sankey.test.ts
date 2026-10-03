import { describe, expect, it } from "vitest";
import { buildSankeyGraph, layoutSankey, type SankeyItem } from "./sankey";

const item = (
  key: string,
  amount: number,
  extra: Partial<SankeyItem> = {},
): SankeyItem => ({ key, label: key, color: null, amount, ...extra });

describe("buildSankeyGraph", () => {
  it("is empty without flows", () => {
    expect(buildSankeyGraph([], [])).toEqual({
      left: [],
      total: null,
      right: [],
    });
    expect(buildSankeyGraph([item("a", 0)], [item("b", -5)]).total).toBeNull();
  });

  it("adds a saved node for a surplus", () => {
    const g = buildSankeyGraph([item("salary", 1000)], [item("rent", 400)]);
    expect(g.total?.value).toBe(1000);
    expect(g.right.map((n) => [n.id, n.value])).toEqual([
      ["expense:rent", 400],
      ["saved", 600],
    ]);
  });

  it("adds a from-savings node for a shortfall", () => {
    const g = buildSankeyGraph([item("salary", 300)], [item("rent", 400)]);
    expect(g.total?.value).toBe(400);
    expect(g.left.map((n) => [n.kind, n.value])).toEqual([
      ["income", 300],
      ["deficit", 100],
    ]);
    expect(g.right.some((n) => n.kind === "saved")).toBe(false);
  });

  it("groups the tail as Other and keeps uncategorized separate", () => {
    const expenses = [
      item("a", 50),
      item("b", 40),
      item("c", 30),
      item("d", 20),
      item("e", 10),
      item("u", 5, { uncategorized: true }),
    ];
    const g = buildSankeyGraph([item("in", 200)], expenses, { maxExpense: 2 });
    expect(g.right.map((n) => [n.label, n.value])).toEqual([
      ["a", 50],
      ["b", 40],
      ["Other", 60],
      ["Uncategorized", 5],
      ["Saved", 45],
    ]);
  });

  it("does not create an Other node for a single leftover", () => {
    const g = buildSankeyGraph(
      [item("in", 100)],
      [item("a", 30), item("b", 20), item("c", 10)],
      { maxExpense: 2 },
    );
    expect(g.right.map((n) => n.label)).toEqual(["a", "b", "c", "Saved"]);
  });
});

describe("layoutSankey", () => {
  const graph = buildSankeyGraph(
    [item("salary", 800), item("side", 200)],
    [item("rent", 500), item("food", 300)],
  );

  it("returns nothing for an empty graph", () => {
    expect(
      layoutSankey(
        { left: [], total: null, right: [] },
        { width: 100, height: 100 },
      ),
    ).toEqual({ nodes: [], links: [] });
  });

  it("scales all columns equally and stays inside the box", () => {
    const { nodes, links } = layoutSankey(graph, { width: 600, height: 300 });
    for (const n of nodes) {
      expect(n.y).toBeGreaterThanOrEqual(-1e-9);
      expect(n.y + n.height).toBeLessThanOrEqual(300 + 1e-9);
    }
    const total = nodes.find((n) => n.kind === "total")!;
    const rent = nodes.find((n) => n.id === "expense:rent")!;
    expect(rent.height / total.height).toBeCloseTo(0.5);
    expect(links).toHaveLength(5);
    const inbound = links.filter((l) => l.target === "total");
    expect(inbound.reduce((s, l) => s + l.strokeWidth, 0)).toBeCloseTo(
      total.height,
    );
  });
});
