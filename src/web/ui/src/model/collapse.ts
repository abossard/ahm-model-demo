import type { Entity, HealthState, Relationship } from "./types";

type HealthFilterState = Exclude<HealthState, "Deleted">;
type ExcludedEntityMode = "hide" | "dot";

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
  readonly dotNames: ReadonlySet<string>;
  /** Hidden descendant count, keyed by the visible collapsed node that hides them. */
  readonly hiddenCounts: ReadonlyMap<string, number>;
  /** How the hidden descendants of each collapsed node split across health states. */
  readonly hiddenStates: ReadonlyMap<string, ReadonlyMap<HealthState, number>>;
}

export interface CollapseControl {
  readonly hiddenCount: number;
}

interface VisibilityOptions {
  readonly selectedHealth?: ReadonlySet<HealthFilterState>;
  readonly excludedEntityMode?: ExcludedEntityMode;
}

export function healthBucket(state: string): HealthState {
  if (state === "Healthy" || state === "Degraded" || state === "Unhealthy" || state === "Deleted") {
    return state;
  }
  return "Unknown";
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
  options?: VisibilityOptions,
): VisibleGraph {
  const mode = options?.excludedEntityMode ?? "hide";
  const selectedHealth =
    options?.selectedHealth ?? new Set<HealthFilterState>(["Healthy", "Degraded", "Unhealthy", "Unknown"]);
  const isVisibleByHealth = (entity: Entity): boolean =>
    healthBucket(entity.healthState) === "Deleted" ||
    selectedHealth.has(healthBucket(entity.healthState) as HealthFilterState);

  if (collapsed.size === 0) {
    const hiddenCounts = new Map<string, number>();
    const hiddenStates = new Map<string, ReadonlyMap<HealthState, number>>();
    const dotNames = new Set<string>();
    const projected =
      mode === "hide"
        ? entities.filter((entity) => isVisibleByHealth(entity))
        : entities.map((entity) => {
            if (!isVisibleByHealth(entity)) dotNames.add(entity.name);
            return entity;
          });
    const projectedNames = new Set(projected.map((entity) => entity.name));
    const projectedRelationships = relationships.filter(
      (item) =>
        projectedNames.has(item.parentEntityName) &&
        projectedNames.has(item.childEntityName),
    );
    return { entities: projected, relationships: projectedRelationships, dotNames, hiddenCounts, hiddenStates };
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
  const visibleBeforeHealth = entities.filter((item) => !hidden.has(item.name));
  const dotNames = new Set<string>();
  const hiddenCounts = new Map<string, number>();
  const hiddenStates = new Map<string, ReadonlyMap<HealthState, number>>();

  for (const name of roots) {
    if (hidden.has(name)) continue;
    const mine = [...(branchOf.get(name) ?? [])].filter((item) => hidden.has(item));
    if (mine.length === 0) continue;
    const countable =
      mode === "hide"
        ? mine.filter((item) => {
            const entity = byName.get(item);
            return entity ? isVisibleByHealth(entity) : false;
          })
        : mine;
    if (countable.length === 0) continue;
    const states = new Map<HealthState, number>();
    for (const item of countable) {
      const state = byName.get(item)?.healthState;
      if (state) {
        const normalized = healthBucket(state);
        states.set(normalized, (states.get(normalized) ?? 0) + 1);
      }
    }
    hiddenCounts.set(name, countable.length);
    hiddenStates.set(name, states);
  }

  const projectedEntities =
    mode === "hide"
      ? visibleBeforeHealth.filter((entity) => isVisibleByHealth(entity))
      : visibleBeforeHealth.map((entity) => {
          if (!isVisibleByHealth(entity)) dotNames.add(entity.name);
          return entity;
        });
  const projectedNames = new Set(projectedEntities.map((item) => item.name));

  return {
    entities: projectedEntities,
    // Two visible endpoints alone are not enough: a collapsed source keeps its own branch edge off
    // the canvas even when the shared child stays visible through another expanded parent.
    relationships: relationships.filter(
      (item) =>
        projectedNames.has(item.parentEntityName) &&
        projectedNames.has(item.childEntityName) &&
        !collapsed.has(item.parentEntityName),
    ),
    dotNames,
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

/**
 * Collapse-toggle ownership stays here with the visibility projection so expanded nodes only get a
 * control when collapsing would either hide at least one effective descendant or cut at least one
 * currently visible branch edge. Collapsed nodes always keep an Expand control.
 */
export function collapseControls(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  collapsed: ReadonlySet<string>,
  options?: VisibilityOptions,
): ReadonlyMap<string, CollapseControl> {
  const controls = new Map<string, CollapseControl>();
  const branches = descendantCounts(entities, relationships);
  const baseline = visibleGraph(entities, relationships, collapsed, options);

  for (const name of branches.keys()) {
    if (collapsed.has(name)) {
      controls.set(name, { hiddenCount: baseline.hiddenCounts.get(name) ?? 0 });
      continue;
    }
    const next = visibleGraph(entities, relationships, new Set([...collapsed, name]), options);
    const hiddenCount = next.hiddenCounts.get(name) ?? 0;
    const currentBranches = baseline.relationships.filter((item) => item.parentEntityName === name).length;
    const nextBranches = next.relationships.filter((item) => item.parentEntityName === name).length;
    if (hiddenCount > 0 || nextBranches < currentBranches) {
      controls.set(name, { hiddenCount });
    }
  }

  return controls;
}
