import type { Entity, Relationship } from "./types";

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
 * A node is hidden when it descends from any collapsed node, even if another parent stays visible.
 * Collapsed nodes remain visible themselves and carry the count of what they hide.
 */
export function visibleGraph(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  collapsed: ReadonlySet<string>,
): VisibleGraph {
  if (collapsed.size === 0) {
    return { entities, relationships, hiddenCounts: new Map() };
  }

  const present = new Set(entities.map((item) => item.name));
  const children = childIndex(realEdges(entities, relationships));
  const hidden = new Set<string>();
  const hiddenCounts = new Map<string, number>();

  for (const name of collapsed) {
    if (!present.has(name)) continue;
    const descendants = descendantsOf(name, children);
    hiddenCounts.set(name, descendants.size);
    for (const descendant of descendants) hidden.add(descendant);
  }

  for (const name of hidden) hiddenCounts.delete(name);
  for (const [name, count] of [...hiddenCounts]) {
    if (count === 0) hiddenCounts.delete(name);
  }

  return {
    entities: entities.filter((item) => !hidden.has(item.name)),
    relationships: relationships.filter(
      (item) => !hidden.has(item.parentEntityName) && !hidden.has(item.childEntityName),
    ),
    hiddenCounts,
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
