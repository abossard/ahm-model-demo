import type { Entity, HealthState, Relationship } from "./types";

/** Only relationships between two distinct entities that are both in the model can hide anything. */
function realEdges(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
): readonly Relationship[] {
  const present = new Set(entities.map((item) => item.name));
  return relationships.filter(
    (item) =>
      item.parentEntityName !== item.childEntityName &&
      present.has(item.parentEntityName) &&
      present.has(item.childEntityName),
  );
}

export interface VisibleGraph {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  /** Hidden descendant count, keyed by the visible collapsed node that hides them. */
  readonly hiddenCounts: ReadonlyMap<string, number>;
  /** How the hidden descendants of each collapsed node split across health states. */
  readonly hiddenStates: ReadonlyMap<string, ReadonlyMap<HealthState, number>>;
}

function childIndex(relationships: readonly Relationship[]): ReadonlyMap<string, string[]> {
  const index = new Map<string, string[]>();
  for (const relationship of relationships) {
    const children = index.get(relationship.parentEntityName);
    if (children) children.push(relationship.childEntityName);
    else index.set(relationship.parentEntityName, [relationship.childEntityName]);
  }
  return index;
}

function descendantsOf(root: string, children: ReadonlyMap<string, string[]>): ReadonlySet<string> {
  const found = new Set<string>();
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (found.has(current) || current === root) continue;
    found.add(current);
    queue.push(...(children.get(current) ?? []));
  }
  return found;
}

/** Descendant count for every node that has children, independent of what is currently collapsed. */
export function descendantCounts(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
): ReadonlyMap<string, number> {
  const children = childIndex(realEdges(entities, relationships));
  const counts = new Map<string, number>();
  for (const item of entities) {
    const size = descendantsOf(item.name, children).size;
    if (size > 0) counts.set(item.name, size);
  }
  return counts;
}

/**
 * A descendant stays visible while at least one path that does not cross a collapsed node's
 * outgoing branch still reaches it, so collapsing one parent of a shared node hides nothing.
 * Collapsed nodes remain visible themselves and carry the count of what they actually hide.
 */
export function visibleGraph(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  collapsed: ReadonlySet<string>,
): VisibleGraph {
  if (collapsed.size === 0) {
    return { entities, relationships, hiddenCounts: new Map(), hiddenStates: new Map() };
  }

  const present = new Set(entities.map((item) => item.name));
  const edges = realEdges(entities, relationships);
  const children = childIndex(edges);
  const roots = [...collapsed].filter((name) => present.has(name));

  const candidates = new Set<string>();
  const branchOf = new Map<string, ReadonlySet<string>>();
  for (const name of roots) {
    const descendants = descendantsOf(name, children);
    branchOf.set(name, descendants);
    for (const descendant of descendants) candidates.add(descendant);
  }

  // Reachability over the graph with every collapsed node's outgoing branch cut. A candidate the
  // sweep still reaches has an uncollapsed path of its own, so only an unreached one is hidden.
  const openChildren = childIndex(edges.filter((item) => !collapsed.has(item.parentEntityName)));
  const reached = new Set<string>();
  const queue = [...present].filter((name) => !candidates.has(name));
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const next of openChildren.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  const hidden = new Set([...candidates].filter((name) => !reached.has(name)));
  const byName = new Map(entities.map((item) => [item.name, item] as const));
  const hiddenCounts = new Map<string, number>();
  const hiddenStates = new Map<string, ReadonlyMap<HealthState, number>>();

  for (const name of roots) {
    if (hidden.has(name)) continue;
    const mine = [...(branchOf.get(name) ?? [])].filter((item) => hidden.has(item));
    if (mine.length === 0) continue;
    const states = new Map<HealthState, number>();
    for (const item of mine) {
      const state = byName.get(item)?.healthState;
      if (state) states.set(state, (states.get(state) ?? 0) + 1);
    }
    hiddenCounts.set(name, mine.length);
    hiddenStates.set(name, states);
  }

  return {
    entities: entities.filter((item) => !hidden.has(item.name)),
    // Two visible endpoints alone are not enough: a collapsed source keeps its own branch edge off
    // the canvas even when the shared child stays visible through another expanded parent.
    relationships: relationships.filter(
      (item) =>
        !hidden.has(item.parentEntityName) &&
        !hidden.has(item.childEntityName) &&
        !collapsed.has(item.parentEntityName),
    ),
    hiddenCounts,
    hiddenStates,
  };
}

/** The collapsed nodes that must be expanded before `target` becomes visible. */
export function ancestorsToExpand(
  target: string,
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  collapsed: ReadonlySet<string>,
): readonly string[] {
  const children = childIndex(realEdges(entities, relationships));
  return [...collapsed].filter(
    (name) => name !== target && descendantsOf(name, children).has(target),
  );
}
