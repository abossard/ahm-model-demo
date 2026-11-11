// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Point } from "./layout";
import { PITCH, planRoutes, sharedTracks, type RouteEdge, type RoutedLine } from "./swimlaneRoute";
import { throughCards, type Rect } from "./stepRouter";

const HEIGHT = 40;
const WIDTH = 80;

const edge = (parent: string, child: string, pill: { width: number; height: number } | null = null): RouteEdge => ({ id: `${parent}>${child}`, parent, child, pill, weight: 0 });

interface Routed {
  readonly lines: readonly RoutedLine[];
  readonly rects: ReadonlyMap<string, Rect>;
  readonly shortages: number;
  readonly channelTops: readonly number[];
  readonly channelHeights: readonly number[];
  readonly line: (parent: string, child: string) => readonly Point[];
}

/** Rows of cards of one size at the given centres, stacked the way the layout stacks them. */
function route(rows: readonly (readonly string[])[], centres: Readonly<Record<string, number>>, edges: readonly RouteEdge[], widths: Readonly<Record<string, number>> = {}): Routed {
  const centre = new Map(Object.entries(centres));
  const width = new Map(rows.flat().map((id) => [id, widths[id] ?? WIDTH] as const));
  const plan = planRoutes({ edges, rows, centre, width });
  let cursor = 40 + plan.channelHeight(-1);
  const tops: number[] = [];
  const channelTops: number[] = [];
  const channelHeights: number[] = [];
  rows.forEach((_row, index) => {
    tops.push(cursor);
    channelTops.push(cursor + HEIGHT + 14);
    channelHeights.push(plan.channelHeight(index));
    cursor += HEIGHT + 14 + plan.channelHeight(index);
  });
  const rects = new Map<string, Rect>();
  rows.forEach((row, index) => row.forEach((id) => rects.set(id, { x: (centre.get(id) as number) - (width.get(id) as number) / 2, y: tops[index] as number, width: width.get(id) as number, height: HEIGHT })));
  const cards = new Map([...rects].map(([id, rect]) => [id, { top: rect.y, bottom: rect.y + rect.height }] as const));
  const lines = plan.realize({ channelTop: (channel) => (channel < 0 ? 40 : (channelTops[channel] as number)), cards });
  return { lines, rects, shortages: plan.shortages.length, channelTops, channelHeights, line: (parent, child) => (lines.find((item) => item.edge.id === `${parent}>${child}`) as RoutedLine).points };
}

const through = (routed: Routed): readonly { edge: string; node: string }[] =>
  throughCards({ nodes: routed.rects, edges: routed.lines.map((item) => ({ id: item.edge.id, from: item.edge.parent, to: item.edge.child, points: item.points, label: null })), bounds: { x: 0, y: 0, width: 0, height: 0 } });

const orthogonal = (points: readonly Point[]): boolean => points.every((point, index) => index === 0 || point.x === (points[index - 1] as Point).x || point.y === (points[index - 1] as Point).y);

describe("planRoutes, one channel", () => {
  it("draws a straight drop where the child sits under its parent, and nothing else", () => {
    const routed = route([["p"], ["a", "b"]], { p: 100, a: 60, b: 140 }, [edge("p", "a"), edge("p", "b")]);
    for (const child of ["a", "b"]) {
      const points = routed.line("p", child);
      expect(points).toHaveLength(2);
      expect(points[0]?.x).toBe(points[1]?.x);
      expect(points[0]?.y).toBe(routed.rects.get(child)?.y);
      expect(points[1]?.y).toBe((routed.rects.get("p")?.y as number) + HEIGHT);
    }
    expect(routed.channelHeights[0]).toBe(0);
  });

  it("gives every edge of a parent a port of its own, PITCH apart and in the order of the children", () => {
    const routed = route([["p"], ["a", "b", "c"]], { p: 200, a: 0, b: 200, c: 400 }, [edge("p", "c"), edge("p", "a"), edge("p", "b")], { p: 200 });
    const ports = ["a", "b", "c"].map((child) => (routed.line("p", child).at(-1) as Point).x);
    expect(ports).toEqual([...ports].sort((x, y) => x - y));
    ports.slice(1).forEach((x, index) => expect(x - (ports[index] as number)).toBeGreaterThanOrEqual(PITCH - 1e-9));
    for (const x of ports) expect(x).toBeGreaterThanOrEqual(100);
    for (const x of ports) expect(x).toBeLessThanOrEqual(300);
    expect(sharedTracks(routed.lines.map((item) => ({ id: item.edge.id, points: item.points })))).toBe(0);
  });

  it("puts two crossing edges on two rows of the channel, never on one line", () => {
    const routed = route([["p1", "p2"], ["c1", "c2"]], { p1: 50, p2: 250, c1: 270, c2: 30 }, [edge("p1", "c1"), edge("p2", "c2")]);
    const horizontals = routed.lines.map((item) => item.points.filter((point, index, all) => index > 0 && point.y === (all[index - 1] as Point).y && point.x !== (all[index - 1] as Point).x).map((point) => point.y));
    expect(horizontals.flat()).toHaveLength(2);
    expect(new Set(horizontals.flat()).size).toBe(2);
    expect(sharedTracks(routed.lines.map((item) => ({ id: item.edge.id, points: item.points })))).toBe(0);
    for (const item of routed.lines) expect(orthogonal(item.points)).toBe(true);
  });

  it("runs an edge between two cards of one row over the top of the row", () => {
    const routed = route([["a", "b"]], { a: 100, b: 300 }, [edge("a", "b")]);
    const points = routed.line("a", "b");
    const top = routed.rects.get("a")?.y as number;
    expect(points).toHaveLength(4);
    expect(points[0]?.y).toBe(top);
    expect(points[3]?.y).toBe(top);
    expect(points[1]?.y).toBeLessThan(top);
    expect(points[2]?.y).toBe(points[1]?.y);
    expect(routed.channelHeights[-1 + 1]).toBe(0);
  });
});

describe("planRoutes, rows skipped", () => {
  it("takes an edge that skips a row through a gap between cards, not through the card in its way", () => {
    const routed = route([["r"], ["x", "y", "z"], ["leaf"]], { r: 150, x: 0, y: 150, z: 300, leaf: 150 }, [edge("r", "leaf"), edge("r", "x"), edge("r", "y"), edge("r", "z")]);
    const points = routed.line("r", "leaf");
    expect(points.length).toBeGreaterThan(2);
    expect(through(routed)).toEqual([]);
    const y = routed.rects.get("y") as Rect;
    for (const point of points) if (point.y > y.y && point.y < y.y + y.height) expect(point.x < y.x || point.x > y.x + y.width).toBe(true);
    for (const item of routed.lines) expect(orthogonal(item.points)).toBe(true);
  });

  it("keeps the risers of edges that pass one row PITCH apart", () => {
    const rows = [["r"], ["m1", "m2", "m3"], ["a", "b", "c"]];
    const routed = route(rows, { r: 300, m1: 100, m2: 300, m3: 500, a: 280, b: 300, c: 320 }, [edge("r", "a"), edge("r", "b"), edge("r", "c"), edge("r", "m1"), edge("r", "m2"), edge("r", "m3")]);
    const middle = routed.rects.get("m1") as Rect;
    const risers: number[] = [];
    for (const item of routed.lines.filter((candidate) => ["a", "b", "c"].includes(candidate.edge.child))) {
      item.points.forEach((point, index, all) => {
        const next = all[index + 1];
        if (next && next.x === point.x && Math.min(point.y, next.y) <= middle.y && Math.max(point.y, next.y) >= middle.y + HEIGHT) risers.push(point.x);
      });
    }
    expect(risers).toHaveLength(3);
    const sorted = [...risers].sort((x, y) => x - y);
    sorted.slice(1).forEach((x, index) => expect(x - (sorted[index] as number)).toBeGreaterThanOrEqual(PITCH - 1e-9));
    expect(through(routed)).toEqual([]);
  });

  it("reports a corridor that finds no free slot and goes round the outside of the row, never through its card", () => {
    const leaves = Array.from({ length: 24 }, (_unused, index) => `l${index}`);
    const centres: Record<string, number> = { r: 150, m: 150 };
    leaves.forEach((id, index) => (centres[id] = 150 + (index - 11.5) * 4));
    const routed = route([["r"], ["m"], leaves], centres, leaves.map((id) => edge("r", id)), Object.fromEntries(leaves.map((id) => [id, 3] as const)));
    expect(routed.shortages).toBeGreaterThan(0);
    expect(through(routed)).toEqual([]);
  });
});

describe("planRoutes, label pills", () => {
  const pill = { width: 70, height: 20 };

  it("sits a pill on its edge's horizontal in the channel above the child, off every card and every other pill", () => {
    const routed = route([["p"], ["a", "b", "c"]], { p: 200, a: 60, b: 200, c: 340 }, [edge("p", "a", pill), edge("p", "b", pill), edge("p", "c", pill)]);
    const boxes = routed.lines.map((item) => item.pill as NonNullable<RoutedLine["pill"]>);
    for (const box of boxes) {
      expect(box.y - box.height / 2).toBeGreaterThanOrEqual(routed.channelTops[0] as number);
      expect(box.y + box.height / 2).toBeLessThanOrEqual((routed.channelTops[0] as number) + (routed.channelHeights[0] as number));
    }
    boxes.forEach((a, index) =>
      boxes.slice(index + 1).forEach((b) => expect(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2).toBe(true)),
    );
  });

  it("gives an edge with no label no pill, and makes no channel for a straight edge without one", () => {
    const routed = route([["p"], ["a"]], { p: 100, a: 100 }, [edge("p", "a")]);
    expect(routed.lines[0]?.pill).toBeNull();
    expect(routed.channelHeights[0]).toBe(0);
  });

  it("makes room for a pill on a straight edge", () => {
    const routed = route([["p"], ["a"]], { p: 100, a: 100 }, [edge("p", "a", pill)]);
    expect(routed.channelHeights[0]).toBeGreaterThan(pill.height);
    expect(routed.lines[0]?.pill?.x).toBe(100);
  });
});
