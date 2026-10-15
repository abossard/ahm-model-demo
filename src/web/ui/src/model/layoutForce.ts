import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import {
  boundsOf,
  linkedRelationships,
  type GraphLayout,
  type LiveLayoutSession,
  type NodeSize,
  type Point,
  type SizeOf,
} from "./layout";
import type { Entity, Relationship } from "./types";

interface ForceNode extends SimulationNodeDatum {
  id: string;
  radius: number;
  width: number;
  height: number;
}

const TICKS = 300;
const RING_STEP = 120;
const MAX_INTERACTION_TICKS = 360;
const LINKED_SEED_DISTANCE = 180;
const LINKED_SEED_RISE = 54;

interface SessionCallbacks {
  readonly onFrame: (layout: GraphLayout) => void;
  readonly onError: (error: Error) => void;
  readonly reducedMotion: boolean;
}

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
      width: size.width,
      height: size.height,
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

function pointToCenter(point: Point, size: NodeSize): Point {
  return { x: point.x + size.width / 2, y: point.y + size.height / 2 };
}

function centerToPoint(center: Point, size: NodeSize): Point {
  return { x: center.x - size.width / 2, y: center.y - size.height / 2 };
}

export function createForceLayoutSession(callbacks: SessionCallbacks): LiveLayoutSession {
  let disposed = false;
  let ticksAfterInput = 0;
  let sizes = new Map<string, NodeSize>();
  let nodes = new Map<string, ForceNode>();
  let simulation = forceSimulation<ForceNode>([])
    .force(
      "link",
      forceLink<ForceNode, SimulationLinkDatum<ForceNode>>([])
        .id((node) => node.id)
        .distance(260)
        .strength(0.6),
    )
    .force("charge", forceManyBody().strength(-1400))
    .force("collide", forceCollide<ForceNode>().radius((node) => node.radius + 24))
    .force("center", forceCenter(0, 0))
    .alphaDecay(0.03);

  const publish = (): void => {
    if (disposed) return;
    const positions = new Map<string, Point>();
    for (const [name, node] of nodes) {
      const size = sizes.get(name) ?? { width: node.width, height: node.height };
      positions.set(name, centerToPoint({ x: node.x ?? 0, y: node.y ?? 0 }, size));
    }
    callbacks.onFrame({ positions, ...boundsOf(positions, sizes) });
  };

  const wireTicking = (): void => {
    simulation.on("tick", () => {
      if (disposed) return;
      ticksAfterInput += 1;
      publish();
      if (ticksAfterInput >= MAX_INTERACTION_TICKS || simulation.alpha() <= simulation.alphaMin()) {
        simulation.stop();
      }
    });
  };

  wireTicking();

  const update = (
    entities: readonly Entity[],
    relationships: readonly Relationship[],
    sizeOf: SizeOf,
    remembered: ReadonlyMap<string, Point>,
  ): void => {
    if (disposed) return;
    try {
      sizes = new Map<string, NodeSize>(entities.map((item) => [item.name, sizeOf(item)] as const));
      const links = linkedRelationships(entities, relationships);
      const existing = nodes;
      const nextNodes = new Map<string, ForceNode>();

      const linkedSeed = (name: string, index: number): Point | null => {
        const survivor = (candidate: string): ForceNode | null =>
          nextNodes.get(candidate) ?? existing.get(candidate) ?? null;
        const neighbor = links.find(
          (item) => {
            if (item.parentEntityName === name) return survivor(item.childEntityName) !== null;
            if (item.childEntityName === name) return survivor(item.parentEntityName) !== null;
            return false;
          },
        );
        if (!neighbor) return null;
        const source = survivor(
          neighbor.parentEntityName === name ? neighbor.childEntityName : neighbor.parentEntityName,
        );
        if (!source) return null;
        const direction = index % 2 === 0 ? 1 : -1;
        return {
          x: (source.x ?? 0) + direction * LINKED_SEED_DISTANCE,
          y: (source.y ?? 0) + direction * LINKED_SEED_RISE,
        };
      };

      for (const [index, entity] of entities.entries()) {
        const size = sizes.get(entity.name) ?? { width: 0, height: 0 };
        const radius = Math.hypot(size.width, size.height) / 2;
        const carried = existing.get(entity.name);
        if (carried) {
          carried.radius = radius;
          carried.width = size.width;
          carried.height = size.height;
          nextNodes.set(entity.name, carried);
          continue;
        }
        const rememberedPoint = remembered.get(entity.name);
        const rememberedCenter = rememberedPoint ? pointToCenter(rememberedPoint, size) : null;
        const survivorSeed = linkedSeed(entity.name, index);
        const angle = (index / Math.max(1, entities.length)) * Math.PI * 2;
        nextNodes.set(entity.name, {
          id: entity.name,
          radius,
          width: size.width,
          height: size.height,
          x: rememberedCenter?.x ?? survivorSeed?.x ?? Math.cos(angle) * RING_STEP * Math.sqrt(index + 1),
          y: rememberedCenter?.y ?? survivorSeed?.y ?? Math.sin(angle) * RING_STEP * Math.sqrt(index + 1),
        });
      }

      nodes = nextNodes;
      const simulationLinks: SimulationLinkDatum<ForceNode>[] = links.map(
        (item) => ({ source: item.parentEntityName, target: item.childEntityName }),
      );

      simulation.nodes([...nodes.values()]);
      const linkForce = simulation.force("link");
      if (!linkForce || !("links" in linkForce)) {
        throw new Error("Live force link configuration is unavailable.");
      }
      (linkForce as ReturnType<typeof forceLink<ForceNode, SimulationLinkDatum<ForceNode>>>).links(simulationLinks);

      ticksAfterInput = 0;
      if (callbacks.reducedMotion) {
        simulation.stop();
        simulation.alpha(0.9);
        simulation.tick(TICKS);
        publish();
        simulation.alpha(0);
        return;
      }
      simulation.alpha(Math.max(simulation.alpha(), 0.85)).restart();
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return {
    update,
    setDrag: (name, position) => {
      if (disposed) return;
      const node = nodes.get(name);
      if (!node) return;
      if (position === null) {
        node.fx = null;
        node.fy = null;
      } else {
        const size = sizes.get(name) ?? { width: node.width, height: node.height };
        const center = pointToCenter(position, size);
        node.fx = center.x;
        node.fy = center.y;
        node.x = center.x;
        node.y = center.y;
        node.vx = 0;
        node.vy = 0;
      }
      ticksAfterInput = 0;
      if (callbacks.reducedMotion) {
        publish();
        return;
      }
      simulation.alpha(Math.max(simulation.alpha(), 0.4)).restart();
    },
    settle: () => {
      if (disposed) return;
      if (callbacks.reducedMotion) {
        simulation.stop();
        publish();
        return;
      }
      simulation.alpha(Math.max(simulation.alpha(), 0.2)).restart();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      simulation.stop();
      simulation.on("tick", null);
      nodes.clear();
      sizes.clear();
    },
  };
}
