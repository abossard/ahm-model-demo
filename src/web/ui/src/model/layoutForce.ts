import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { boundsOf, linkedRelationships, type GraphLayout, type NodeSize, type Point, type SizeOf } from "./layout";
import type { Entity, Relationship } from "./types";

interface ForceNode extends SimulationNodeDatum {
  readonly id: string;
  readonly radius: number;
}

const TICKS = 300;
const RING_STEP = 120;

/**
 * Runs headless and deterministically: the simulation is stopped before it can start its animation
 * timer, seeded from the caller's node order, then ticked a fixed number of times.
 */
export function forceLayout(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizeOf: SizeOf,
): Promise<GraphLayout> {
  const sizes = new Map<string, NodeSize>(entities.map((item) => [item.name, sizeOf(item)] as const));

  const nodes: ForceNode[] = entities.map((item, index) => {
    const size = sizes.get(item.name) ?? { width: 0, height: 0 };
    const angle = (index / Math.max(1, entities.length)) * Math.PI * 2;
    const radius = Math.hypot(size.width, size.height) / 2;
    return {
      id: item.name,
      radius,
      x: Math.cos(angle) * RING_STEP * Math.sqrt(index + 1),
      y: Math.sin(angle) * RING_STEP * Math.sqrt(index + 1),
    };
  });

  const links: SimulationLinkDatum<ForceNode>[] = linkedRelationships(entities, relationships).map(
    (item) => ({ source: item.parentEntityName, target: item.childEntityName }),
  );

  const simulation = forceSimulation(nodes)
    .force(
      "link",
      forceLink<ForceNode, SimulationLinkDatum<ForceNode>>(links)
        .id((node) => node.id)
        .distance(260)
        .strength(0.6),
    )
    .force("charge", forceManyBody().strength(-1400))
    .force("collide", forceCollide<ForceNode>().radius((node) => node.radius + 24))
    .force("center", forceCenter(0, 0))
    .stop();

  simulation.tick(TICKS);

  const minX = Math.min(...nodes.map((node) => (node.x ?? 0) - node.radius));
  const minY = Math.min(...nodes.map((node) => (node.y ?? 0) - node.radius));

  const positions = new Map<string, Point>();
  for (const node of nodes) {
    const size = sizes.get(node.id) ?? { width: 0, height: 0 };
    positions.set(node.id, {
      x: (node.x ?? 0) - size.width / 2 - minX,
      y: (node.y ?? 0) - size.height / 2 - minY,
    });
  }

  return Promise.resolve({ positions, ...boundsOf(positions, sizes) });
}
