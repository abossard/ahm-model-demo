import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { boundsOf, linkedRelationships, type GraphLayout, type NodeSize, type Point, type SizeOf } from "./layout";
import { ranksFromPositions } from "./customOrder";
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

/**
 * The relationships of one connected component that form a tree from its root, in the order given.
 * ELK radial is a tree layout and does not return for a component where a node has two parents.
 */
export function spanningTree(
  group: readonly Entity[],
  relationships: readonly Relationship[],
): readonly Relationship[] {
  const hasParent = new Set(relationships.map((item) => item.childEntityName));
  const root = (group.find((item) => !hasParent.has(item.name)) ?? group[0])?.name;
  if (root === undefined) return [];

  const touching = new Map<string, Relationship[]>();
  for (const item of relationships) {
    for (const end of [item.parentEntityName, item.childEntityName]) {
      const existing = touching.get(end);
      if (existing) existing.push(item);
      else touching.set(end, [item]);
    }
  }

  const reached = new Set([root]);
  const kept = new Map<string, Relationship>();
  const queue = [root];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] as string;
    for (const item of touching.get(current) ?? []) {
      const other = item.parentEntityName === current ? item.childEntityName : item.parentEntityName;
      if (reached.has(other)) continue;
      reached.add(other);
      queue.push(other);
      // The edge points away from the root, whichever way the relationship does.
      kept.set(item.name, { ...item, parentEntityName: current, childEntityName: other });
    }
  }
  return relationships.flatMap((item) => kept.get(item.name) ?? []);
}

/** Layers keep the order the nodes are given in, as far as that is possible. */
const MODEL_ORDER: Readonly<Record<string, string>> = {
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
};

async function runElk(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizes: ReadonlyMap<string, NodeSize>,
  algorithm: ElkAlgorithm,
  sequence?: readonly string[],
): Promise<Map<string, Point>> {
  const place = new Map((sequence ?? []).map((name, index) => [name, index] as const));
  // Entities the sequence does not know follow the ones it does, in the order they came.
  const given = sequence
    ? [...entities].sort((left, right) => (place.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (place.get(right.name) ?? Number.MAX_SAFE_INTEGER))
    : entities;
  const graph: ElkNode = {
    id: "root",
    layoutOptions: sequence ? { ...OPTIONS[algorithm], ...MODEL_ORDER } : OPTIONS[algorithm],
    children: given.map((item) => {
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
const RADIAL_CLEAR_GAP = 24;

interface Placed extends Point, NodeSize {}

function overlaps(left: Placed, right: Placed): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function escape(box: Placed, blocker: Placed): Point {
  const options: readonly Point[] = [
    { x: blocker.x + blocker.width + RADIAL_CLEAR_GAP - box.x, y: 0 },
    { x: blocker.x - RADIAL_CLEAR_GAP - (box.x + box.width), y: 0 },
    { x: 0, y: blocker.y + blocker.height + RADIAL_CLEAR_GAP - box.y },
    { x: 0, y: blocker.y - RADIAL_CLEAR_GAP - (box.y + box.height) },
  ];
  return options.reduce((best, option) =>
    Math.hypot(option.x, option.y) < Math.hypot(best.x, best.y) ? option : best,
  );
}

function clearRadialOverlaps(
  positions: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
): Map<string, Point> {
  const ordered = [...positions.entries()].sort((left, right) =>
    left[1].y === right[1].y
      ? left[1].x === right[1].x
        ? left[0].localeCompare(right[0])
        : left[1].x - right[1].x
      : left[1].y - right[1].y,
  );
  const settled: Placed[] = [];
  const corrected = new Map<string, Point>();

  for (const [name, point] of ordered) {
    const size = sizes.get(name) ?? { width: 0, height: 0 };
    let box: Placed = { x: point.x, y: point.y, width: size.width, height: size.height };
    for (let pass = 0; pass <= settled.length; pass += 1) {
      const blocker = settled.find((other) => overlaps(box, other));
      if (!blocker) break;
      const move = escape(box, blocker);
      box = { ...box, x: box.x + move.x, y: box.y + move.y };
    }
    corrected.set(name, { x: box.x, y: box.y });
    settled.push(box);
  }
  return corrected;
}

export async function elkLayout(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: SizeOf,
  algorithm: ElkAlgorithm,
  /** Entity names in the order the layers should keep (ELK layered only). */
  sequence?: readonly string[],
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
              spanningTree(group, linked.filter((item) => names.has(item.parentEntityName))),
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
    for (const [name, point] of await runElk(entities, linked, sizes, algorithm, sequence)) {
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

  const finalPositions = algorithm === "radial" ? clearRadialOverlaps(positions, sizes) : positions;
  return {
    positions: finalPositions,
    ...boundsOf(finalPositions, sizes),
    ...(algorithm === "layered" ? { ranks: ranksFromPositions(finalPositions, "x") } : {}),
  };
}
