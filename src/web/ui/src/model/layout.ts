import dagre from "@dagrejs/dagre";
import type { Entity, Relationship } from "./types";
import { elkLayout } from "./layoutElk";
import { forceLayout } from "./layoutForce";
import type { LayoutFlow } from "./edgeRouting";

export interface NodeSize {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface GraphLayout {
  readonly positions: ReadonlyMap<string, Point>;
  readonly width: number;
  readonly height: number;
}

export type SizeOf = (entity: Entity) => NodeSize;

interface Placed extends Point, NodeSize {}

/** Clearance left between an arriving node and the settled node it had to be pushed past. */
const ANCHOR_GAP = 48;

function boxOf(point: Point, size: NodeSize): Placed {
  return { x: point.x, y: point.y, width: size.width, height: size.height };
}

function overlaps(left: Placed, right: Placed): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

/**
 * The shortest move that lifts `box` off `blocker`, chosen from the four axis-aligned escapes. Ties
 * fall to the first option in a fixed order, so the same collision always resolves the same way.
 */
function escape(box: Placed, blocker: Placed): Point {
  const options: readonly Point[] = [
    { x: blocker.x + blocker.width + ANCHOR_GAP - box.x, y: 0 },
    { x: blocker.x - ANCHOR_GAP - (box.x + box.width), y: 0 },
    { x: 0, y: blocker.y + blocker.height + ANCHOR_GAP - box.y },
    { x: 0, y: blocker.y - ANCHOR_GAP - (box.y + box.height) },
  ];
  return options.reduce((best, option) =>
    Math.hypot(option.x, option.y) < Math.hypot(best.x, best.y) ? option : best,
  );
}

/*
 * ponytail: each arriving node is nudged off the first box it lands on and re-tested, which is a
 * linear sweep rather than a packing search. Swap in a real placement search when a dense pocket
 * makes the nudge visibly wasteful.
 */
function placeClear(wanted: Placed, taken: readonly Placed[]): Point {
  let box = wanted;
  for (let pass = 0; pass <= taken.length; pass += 1) {
    const blocker = taken.find((other) => overlaps(box, other));
    if (!blocker) break;
    const move = escape(box, blocker);
    box = { ...box, x: box.x + move.x, y: box.y + move.y };
  }
  return { x: box.x, y: box.y };
}

/**
 * Re-seats a freshly computed layout onto the positions the graph already occupies: every node the
 * caller remembers keeps its exact coordinates, and only a node with no remembered position is
 * placed, and only pushed when it would actually land on something. A node that does not collide
 * therefore never moves.
 */
export function anchorLayout(
  next: GraphLayout,
  previous: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
): GraphLayout {
  const positions = new Map<string, Point>();
  const arriving: string[] = [];
  for (const name of next.positions.keys()) {
    const before = previous.get(name);
    if (before) positions.set(name, before);
    else arriving.push(name);
  }
  if (positions.size === 0) return next;
  if (arriving.length === 0) return { positions, ...boundsOf(positions, sizes) };

  // The fresh layout is slid so the settled node nearest the arrivals lines up with where it already
  // sits, which keeps the arrivals in the relation the engine chose for them.
  const zero = { x: 0, y: 0 };
  const centre = arriving.reduce(
    (sum, name) => {
      const point = next.positions.get(name) ?? zero;
      return { x: sum.x + point.x / arriving.length, y: sum.y + point.y / arriving.length };
    },
    { x: 0, y: 0 },
  );
  const anchor = [...positions.keys()].reduce((best, name) => {
    const here = next.positions.get(name) ?? zero;
    const there = next.positions.get(best) ?? zero;
    return Math.hypot(here.x - centre.x, here.y - centre.y) <
      Math.hypot(there.x - centre.x, there.y - centre.y)
      ? name
      : best;
  });
  const from = next.positions.get(anchor) ?? zero;
  const to = positions.get(anchor) as Point;

  const taken: Placed[] = [...positions].map(([name, point]) =>
    boxOf(point, sizes.get(name) ?? { width: 0, height: 0 }),
  );
  for (const name of [...arriving].sort()) {
    const point = next.positions.get(name) as Point;
    const size = sizes.get(name) ?? { width: 0, height: 0 };
    const wanted = boxOf({ x: point.x + (to.x - from.x), y: point.y + (to.y - from.y) }, size);
    const placed = placeClear(wanted, taken);
    positions.set(name, placed);
    taken.push(boxOf(placed, size));
  }

  return { positions, ...boundsOf(positions, sizes) };
}

/** The axis along which same-rank nodes spread. `null` means the layout has no ranks. */
export type RankAxis = "x" | "y" | null;

/**
 * Where an engine's edge geometry comes from. `computed` is the obstacle-aware router in
 * `edgeRouting.ts`. Nothing declares `engine` today: `orderWithinRanks` re-seats same-rank nodes
 * after the engine has run, so dagre's edge points and ELK's edge sections describe coordinates the
 * cards no longer occupy, and radial and force emit no usable route at all. The declaration is
 * asserted per layout id so wiring an engine route in, or losing one, cannot pass unnoticed.
 */
export type RouteSource = "computed" | "engine";

export type LayoutId =
  | "dagre-tb"
  | "dagre-bt"
  | "dagre-lr"
  | "dagre-rl"
  | "elk-layered"
  | "elk-radial"
  | "d3-force";

export interface LayoutEngine {
  readonly id: LayoutId;
  readonly label: string;
  readonly rankAxis: RankAxis;
  readonly flow: LayoutFlow;
  readonly routeSource: RouteSource;
  readonly run: (
    entities: readonly Entity[],
    relationships: readonly Relationship[],
    sizeOf: SizeOf,
  ) => Promise<GraphLayout>;
}

export const DEFAULT_LAYOUT_ID: LayoutId = "dagre-tb";

type RankDir = "TB" | "BT" | "LR" | "RL";

export function linkedRelationships(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
): readonly Relationship[] {
  const present = new Set(entities.map((entity) => entity.name));
  return relationships.filter(
    (item) => present.has(item.parentEntityName) && present.has(item.childEntityName),
  );
}

export function boundsOf(
  positions: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
): { readonly width: number; readonly height: number } {
  let width = 0;
  let height = 0;
  for (const [name, point] of positions) {
    const size = sizes.get(name) ?? { width: 0, height: 0 };
    width = Math.max(width, point.x + size.width);
    height = Math.max(height, point.y + size.height);
  }
  return { width, height };
}

function dagreLayout(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: SizeOf,
  rankdir: RankDir,
): GraphLayout {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir, nodesep: 48, ranksep: 72, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));

  const sizes = new Map<string, NodeSize>();
  for (const entity of entities) {
    const size = sizeOf(entity);
    sizes.set(entity.name, size);
    graph.setNode(entity.name, { width: size.width, height: size.height });
  }
  for (const relationship of linkedRelationships(entities, relationships)) {
    graph.setEdge(relationship.parentEntityName, relationship.childEntityName);
  }

  dagre.layout(graph);

  // Ranks share a centre `y` only when they stack vertically; there the tops must be aligned.
  const vertical = rankdir === "TB" || rankdir === "BT";
  const rankTop = new Map<number, number>();
  if (vertical) {
    for (const entity of entities) {
      const node = graph.node(entity.name);
      const top = node.y - node.height / 2;
      const current = rankTop.get(node.y);
      if (current === undefined || top < current) rankTop.set(node.y, top);
    }
  }

  const positions = new Map<string, Point>();
  for (const entity of entities) {
    const node = graph.node(entity.name);
    positions.set(entity.name, {
      x: node.x - node.width / 2,
      y: vertical ? (rankTop.get(node.y) ?? node.y - node.height / 2) : node.y - node.height / 2,
    });
  }

  return { positions, ...boundsOf(positions, sizes) };
}

function dagreEngine(id: LayoutId, label: string, rankdir: RankDir): LayoutEngine {
  return {
    id,
    label,
    rankAxis: rankdir === "TB" || rankdir === "BT" ? "x" : "y",
    flow: rankdir.toLowerCase() as LayoutFlow,
    routeSource: "computed",
    run: (entities, relationships, sizeOf) =>
      Promise.resolve(dagreLayout(entities, relationships, sizeOf, rankdir)),
  };
}

export const LAYOUT_CHOICES: readonly LayoutEngine[] = [
  dagreEngine("dagre-tb", "Hierarchy — top down", "TB"),
  dagreEngine("dagre-bt", "Hierarchy — bottom up", "BT"),
  dagreEngine("dagre-lr", "Hierarchy — left to right", "LR"),
  dagreEngine("dagre-rl", "Hierarchy — right to left", "RL"),
  {
    id: "elk-layered",
    label: "ELK layered",
    rankAxis: "x",
    flow: "tb",
    routeSource: "computed",
    run: (entities, relationships, sizeOf) => elkLayout(entities, relationships, sizeOf, "layered"),
  },
  {
    id: "elk-radial",
    label: "ELK radial",
    rankAxis: null,
    flow: "free",
    routeSource: "computed",
    run: (entities, relationships, sizeOf) => elkLayout(entities, relationships, sizeOf, "radial"),
  },
  {
    id: "d3-force",
    label: "Force directed",
    rankAxis: null,
    flow: "free",
    routeSource: "computed",
    run: (entities, relationships, sizeOf) => forceLayout(entities, relationships, sizeOf),
  },
];

export const LAYOUT_ENGINES: Readonly<Record<LayoutId, LayoutEngine>> = Object.fromEntries(
  LAYOUT_CHOICES.map((engine) => [engine.id, engine]),
) as Record<LayoutId, LayoutEngine>;

/** Retained for callers that only ever want the default top-down hierarchy. */
export function layoutGraph(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: SizeOf,
): GraphLayout {
  return dagreLayout(entities, relationships, sizeOf, "TB");
}
