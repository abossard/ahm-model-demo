import dagre from "@dagrejs/dagre";
import type { Entity, Relationship } from "./types";

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

export function layoutGraph(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: (entity: Entity) => NodeSize,
): GraphLayout {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 72, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));

  const present = new Set(entities.map((entity) => entity.name));
  for (const entity of entities) {
    const { width, height } = sizeOf(entity);
    graph.setNode(entity.name, { width, height });
  }
  for (const relationship of relationships) {
    if (!present.has(relationship.parentEntityName)) continue;
    if (!present.has(relationship.childEntityName)) continue;
    graph.setEdge(relationship.parentEntityName, relationship.childEntityName);
  }

  dagre.layout(graph);

  const rankTop = new Map<number, number>();
  for (const entity of entities) {
    const node = graph.node(entity.name);
    const top = node.y - node.height / 2;
    const current = rankTop.get(node.y);
    if (current === undefined || top < current) rankTop.set(node.y, top);
  }

  const positions = new Map<string, Point>();
  for (const entity of entities) {
    const node = graph.node(entity.name);
    positions.set(entity.name, {
      x: node.x - node.width / 2,
      y: rankTop.get(node.y) ?? node.y - node.height / 2,
    });
  }

  const meta = graph.graph();
  return { positions, width: meta.width ?? 0, height: meta.height ?? 0 };
}
