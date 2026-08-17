import dagre from "@dagrejs/dagre";
import type { Entity, Relationship } from "./types";
import { elkLayout } from "./layoutElk";
import { forceLayout } from "./layoutForce";

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

/** The axis along which same-rank nodes spread. `null` means the layout has no ranks. */
export type RankAxis = "x" | "y" | null;

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
    run: (entities, relationships, sizeOf) => elkLayout(entities, relationships, sizeOf, "layered"),
  },
  {
    id: "elk-radial",
    label: "ELK radial",
    rankAxis: null,
    run: (entities, relationships, sizeOf) => elkLayout(entities, relationships, sizeOf, "radial"),
  },
  {
    id: "d3-force",
    label: "Force directed",
    rankAxis: null,
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
