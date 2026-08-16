import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { boundsOf, linkedRelationships, type GraphLayout, type NodeSize, type Point, type SizeOf } from "./layout";
import type { Entity, Relationship } from "./types";

export type ElkAlgorithm = "layered" | "radial";

// The bundled build runs on the main thread. The worker build would fetch a script URL and trip the
// served `script-src 'self'` policy.
const elk = new ELK();

const OPTIONS: Readonly<Record<ElkAlgorithm, Record<string, string>>> = {
  layered: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "72",
    "elk.spacing.nodeNode": "48",
  },
  radial: {
    "elk.algorithm": "radial",
    // Radial places nodes on rings by centre, so the spacing must clear a whole card or the
    // rendered cards overlap and swallow each other's collapse toggles.
    "elk.spacing.nodeNode": "320",
  },
};

export async function elkLayout(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: SizeOf,
  algorithm: ElkAlgorithm,
): Promise<GraphLayout> {
  const sizes = new Map<string, NodeSize>(entities.map((item) => [item.name, sizeOf(item)] as const));
  const linked = linkedRelationships(entities, relationships);

  // Radial is a tree layout: it stacks every disconnected node on one identical coordinate, so
  // isolated entities are laid out separately instead of being handed to ELK.
  const connected = new Set<string>();
  for (const item of linked) {
    connected.add(item.parentEntityName);
    connected.add(item.childEntityName);
  }
  const isolated =
    algorithm === "radial" ? entities.filter((item) => !connected.has(item.name)) : [];
  const placedByElk = entities.filter((item) => !isolated.includes(item));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: OPTIONS[algorithm],
    children: placedByElk.map((item) => {
      const size = sizes.get(item.name) ?? { width: 0, height: 0 };
      return { id: item.name, width: size.width, height: size.height };
    }),
    edges: linked.map((item) => ({
      id: item.name,
      sources: [item.parentEntityName],
      targets: [item.childEntityName],
    })),
  };

  const laid = await elk.layout(graph);
  const positions = new Map<string, Point>();
  for (const child of laid.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  const laidOut = boundsOf(positions, sizes);
  let parkedX = 0;
  for (const item of entities) {
    if (positions.has(item.name)) continue;
    positions.set(item.name, { x: parkedX, y: laidOut.height + 72 });
    parkedX += (sizes.get(item.name)?.width ?? 0) + 48;
  }

  return { positions, ...boundsOf(positions, sizes) };
}
