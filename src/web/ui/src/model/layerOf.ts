import { impactOf } from "./palette";
import type { Entity, Relationship } from "./types";

/**
 * Which lane of the Swimlanes view an entity sits in. The API has no kind for an entity, so the
 * lane is derived from the graph: depth from the root and structure first (a part with parts of
 * its own versus a leaf that carries signals), names only to tell a flow lane from a system lane
 * when the model has one inner layer and nothing else says which it is.
 *
 * The rule, in order:
 * 1. The root is the parentless entity with the most descendants that is not itself context.
 * 2. Context is what the rollup does not use or the root does not reach: Suppressed impact,
 *    discovered or unlinked entities, anything that is not below the root, anything whose parents
 *    are all context, and a leaf hanging straight off a root that has structure (it belongs to no
 *    flow and no system).
 * 3. Every other part with children of its own sits one lane below its deepest parent, starting
 *    below the root; every other leaf sits in the last lane, so an entity with parents in
 *    different lanes lands in the deepest lane that keeps every parent above it.
 */
export type LaneKind = "root" | "flows" | "systems" | "resources" | "context";

export interface Lane {
  readonly kind: LaneKind;
  readonly title: string;
  /** The entities of the lane, by name. */
  readonly names: readonly string[];
}

export interface Layering {
  /** Top to bottom; a lane nothing sits in is not listed. */
  readonly lanes: readonly Lane[];
  /** The index in `lanes` of every entity. */
  readonly laneOf: ReadonlyMap<string, number>;
}

export const LANE_TITLES: Readonly<Record<LaneKind, string>> = {
  root: "Workload root",
  flows: "User flows",
  systems: "System components",
  resources: "Azure resources",
  context: "Context and discovery",
};

const SYSTEM_NAME = /^(sys|system)[-_]/i;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Graph {
  readonly names: readonly string[];
  readonly parents: ReadonlyMap<string, readonly string[]>;
  readonly children: ReadonlyMap<string, readonly string[]>;
}

function graphOf(entities: readonly Entity[], relationships: readonly Relationship[]): Graph {
  const names = [...new Set(entities.map((entity) => entity.name))].sort(byText);
  const present = new Set(names);
  const parents = new Map<string, Set<string>>(names.map((name) => [name, new Set()]));
  const children = new Map<string, Set<string>>(names.map((name) => [name, new Set()]));
  for (const item of relationships) {
    const { parentEntityName: parent, childEntityName: child } = item;
    if (parent === child || !present.has(parent) || !present.has(child)) continue;
    parents.get(child)?.add(parent);
    children.get(parent)?.add(child);
  }
  const sorted = (index: ReadonlyMap<string, Set<string>>): ReadonlyMap<string, readonly string[]> =>
    new Map([...index].map(([name, set]) => [name, [...set].sort(byText)] as const));
  return { names, parents: sorted(parents), children: sorted(children) };
}

function descendantsOf(graph: Graph, start: string): ReadonlySet<string> {
  const found = new Set<string>();
  const pending = [...(graph.children.get(start) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (found.has(next) || next === start) continue;
    found.add(next);
    pending.push(...(graph.children.get(next) ?? []));
  }
  return found;
}

/** What the rollup does not use or the API says was discovered or left unlinked. */
function marked(entity: Entity): boolean {
  return impactOf(entity.impact) === "Suppressed" || entity.discoveredBy !== null || entity.unlinked;
}

function rootOf(graph: Graph, byName: ReadonlyMap<string, Entity>): string | null {
  const candidates = graph.names.filter((name) => (graph.parents.get(name) ?? []).length === 0);
  const pool = candidates.length > 0 ? candidates : graph.names;
  let best: string | null = null;
  let bestKey: readonly [number, number] = [-1, -1];
  for (const name of pool) {
    const key: readonly [number, number] = [marked(byName.get(name) as Entity) ? 0 : 1, descendantsOf(graph, name).size];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = name;
      bestKey = key;
    }
  }
  return best;
}

function contextOf(graph: Graph, byName: ReadonlyMap<string, Entity>, root: string): ReadonlySet<string> {
  const below = descendantsOf(graph, root);
  const context = new Set<string>();
  const structured = (graph.children.get(root) ?? []).some((child) => (graph.children.get(child) ?? []).length > 0);
  for (const name of graph.names) {
    if (name === root) continue;
    const parents = graph.parents.get(name) ?? [];
    const leaf = (graph.children.get(name) ?? []).length === 0;
    const straightOffTheRoot = structured && leaf && parents.length === 1 && parents[0] === root;
    if (!below.has(name) || marked(byName.get(name) as Entity) || straightOffTheRoot) context.add(name);
  }
  // A part whose parents are all context is context too, however deep.
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of graph.names) {
      if (name === root || context.has(name)) continue;
      const parents = graph.parents.get(name) ?? [];
      if (parents.length > 0 && parents.every((parent) => context.has(parent))) {
        context.add(name);
        changed = true;
      }
    }
  }
  return context;
}

/** Longest distance from the root over the edges between parts that are not context, ignoring any edge that closes a cycle. */
function depthsOf(graph: Graph, root: string, context: ReadonlySet<string>): ReadonlyMap<string, number> {
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const visit = (name: string, at: number): void => {
    if (onPath.has(name)) return;
    if ((depth.get(name) ?? -1) >= at) return;
    depth.set(name, at);
    onPath.add(name);
    for (const child of graph.children.get(name) ?? []) if (!context.has(child)) visit(child, at + 1);
    onPath.delete(name);
  };
  visit(root, 0);
  return depth;
}

export function layerOf(entities: readonly Entity[], relationships: readonly Relationship[]): Layering {
  const graph = graphOf(entities, relationships);
  const byName = new Map(entities.map((entity) => [entity.name, entity] as const));
  const root = rootOf(graph, byName);
  if (root === null) return { lanes: [], laneOf: new Map() };

  const context = contextOf(graph, byName, root);
  const depth = depthsOf(graph, root, context);
  const hasMainChildren = (name: string): boolean => (graph.children.get(name) ?? []).some((child) => !context.has(child));
  const main = graph.names.filter((name) => !context.has(name) && name !== root);
  const inner = main.filter(hasMainChildren);
  const levels = [...new Set(inner.map((name) => depth.get(name) ?? 1))].sort((a, b) => a - b);
  // Inner parts keep their order by depth, squeezed so that no lane is empty; the leaves get the lane below the last.
  const levelOf = new Map<string, number>(inner.map((name) => [name, levels.indexOf(depth.get(name) ?? 1) + 1] as const));

  const lanes: { kind: LaneKind; title: string; names: string[] }[] = [{ kind: "root", title: LANE_TITLES.root, names: [root] }];
  for (let level = 1; level <= levels.length; level += 1) {
    const names = inner.filter((name) => levelOf.get(name) === level);
    const systems = level > 1 || (levels.length === 1 && names.every((name) => SYSTEM_NAME.test(name)));
    const title = !systems ? LANE_TITLES.flows : level <= 2 ? LANE_TITLES.systems : `${LANE_TITLES.systems}, level ${level - 1}`;
    lanes.push({ kind: systems ? "systems" : "flows", title, names });
  }
  const leaves = main.filter((name) => !hasMainChildren(name));
  if (leaves.length > 0) lanes.push({ kind: "resources", title: LANE_TITLES.resources, names: leaves });
  if (context.size > 0) lanes.push({ kind: "context", title: LANE_TITLES.context, names: graph.names.filter((name) => context.has(name)) });

  const laneOf = new Map<string, number>();
  lanes.forEach((lane, index) => lane.names.forEach((name) => laneOf.set(name, index)));
  return { lanes, laneOf };
}
