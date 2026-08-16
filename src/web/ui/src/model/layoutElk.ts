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

/** Undirected connected components, so a tree layout can be run once per component. */
function componentsOf(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
): readonly (readonly Entity[])[] {
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const existing = neighbours.get(from);
    if (existing) existing.push(to);
    else neighbours.set(from, [to]);
  };
  for (const item of relationships) {
    link(item.parentEntityName, item.childEntityName);
    link(item.childEntityName, item.parentEntityName);
  }

  const byName = new Map(entities.map((item) => [item.name, item] as const));
  const seen = new Set<string>();
  const groups: Entity[][] = [];
  for (const entity of entities) {
    if (seen.has(entity.name)) continue;
    const group: Entity[] = [];
    const queue = [entity.name];
    seen.add(entity.name);
    while (queue.length > 0) {
      const current = queue.pop() as string;
      const item = byName.get(current);
      if (item) group.push(item);
      for (const next of neighbours.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    groups.push(group);
  }
  return groups;
}

async function runElk(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizes: ReadonlyMap<string, NodeSize>,
  algorithm: ElkAlgorithm,
): Promise<Map<string, Point>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: OPTIONS[algorithm],
    children: entities.map((item) => {
      const size = sizes.get(item.name) ?? { width: 0, height: 0 };
      return { id: item.name, width: size.width, height: size.height };
    }),
    edges: relationships.map((item) => ({
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
  return positions;
}

const COMPONENT_GAP = 72;

export async function elkLayout(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: SizeOf,
  algorithm: ElkAlgorithm,
): Promise<GraphLayout> {
  const sizes = new Map<string, NodeSize>(entities.map((item) => [item.name, sizeOf(item)] as const));
  const linked = linkedRelationships(entities, relationships);
  const positions = new Map<string, Point>();

  if (algorithm === "radial") {
    /*
     * Radial is a tree layout: handed a disconnected graph it stacks whole components — and every
     * degree-zero node — onto the same coordinates. Each component is laid out on its own and the
     * results are stacked vertically, which also covers the single-node case.
     */
    const groups = [...componentsOf(entities, linked)].sort((left, right) => right.length - left.length);
    let offsetY = 0;
    for (const group of groups) {
      const names = new Set(group.map((item) => item.name));
      const inner =
        group.length > 1
          ? await runElk(
              group,
              linked.filter((item) => names.has(item.parentEntityName)),
              sizes,
              algorithm,
            )
          : new Map<string, Point>([[group[0]?.name ?? "", { x: 0, y: 0 }]]);

      for (const [name, point] of inner) {
        if (!names.has(name)) continue;
        positions.set(name, { x: point.x, y: point.y + offsetY });
      }
      offsetY = boundsOf(positions, sizes).height + COMPONENT_GAP;
    }
  } else {
    for (const [name, point] of await runElk(entities, linked, sizes, algorithm)) {
      positions.set(name, point);
    }
  }

  // Anything ELK declined to place is parked in a row below the graph rather than left at the origin.
  const laidOut = boundsOf(positions, sizes);
  let parkedX = 0;
  for (const item of entities) {
    if (positions.has(item.name)) continue;
    positions.set(item.name, { x: parkedX, y: laidOut.height + COMPONENT_GAP });
    parkedX += (sizes.get(item.name)?.width ?? 0) + 48;
  }

  return { positions, ...boundsOf(positions, sizes) };
}
