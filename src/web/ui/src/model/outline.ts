import { healthBucket } from "./collapse";
import { HEALTH_SORT_ORDER } from "./ordering";
import { formatSignalValue } from "./signalValue";
import type { Entity, HealthState, Relationship } from "./types";

/** A signal that is not Healthy, as one inline mark of its entity's row. */
export interface SignalMark {
  readonly name: string;
  /** The value as a reader wants it, or "no data". */
  readonly value: string;
  readonly state: HealthState;
}

export interface SignalCount {
  readonly state: HealthState;
  readonly count: number;
}

/**
 * One row of the outline. An entity is shown in full once, under the first parent the walk reaches;
 * under its other parents it is an `also` row, a reference that names where the full row is.
 */
export interface OutlineRow {
  /** The tree item's value: the entity name, or `also:<parent>:<name>` for a reference. */
  readonly key: string;
  readonly kind: "entity" | "also";
  readonly entity: Entity;
  readonly parentKey: string | null;
  /** From 1, like `aria-level`. */
  readonly level: number;
  /** Place among the siblings, from 1, like `aria-posinset`. */
  readonly position: number;
  readonly setSize: number;
  /** The entity has children to show; only an `entity` row can. */
  readonly expandable: boolean;
  readonly open: boolean;
  /** Entities below this one, and how many of them need attention (Degraded, Unhealthy or Unknown). */
  readonly below: number;
  readonly belowTrouble: number;
  /** For an `also` row: the parent the full row sits under, or null when it sits at the top. */
  readonly shownUnder: string | null;
  readonly failing: readonly SignalMark[];
  readonly counts: readonly SignalCount[];
  /** Drawn faint: the Health filter excludes it and shows excluded entities as dots. */
  readonly dimmed: boolean;
  readonly height: number;
}

/** A row of one line, and one with its failing signals on a second line. */
export const ROW_HEIGHT = 36;
export const ROW_HEIGHT_WITH_SIGNALS = 58;
/** Most failing signals named on a row; the rest are counted. */
export const INLINE_SIGNALS = 3;

const ATTENTION: ReadonlySet<string> = new Set(["Degraded", "Unhealthy", "Unknown"]);

function severity(state: string): number {
  return HEALTH_SORT_ORDER.indexOf(healthBucket(state));
}

function labelOf(entity: Entity): string {
  return (entity.displayName || entity.name).toLocaleLowerCase();
}

/** Worst first (Unhealthy, Degraded, Unknown, Healthy), then by name. */
function compareEntities(left: Entity, right: Entity): number {
  return severity(left.healthState) - severity(right.healthState) || labelOf(left).localeCompare(labelOf(right)) || left.name.localeCompare(right.name);
}

/** The signals that are not Healthy, worst first. A signal without a value says "no data". */
export function failingSignals(entity: Entity): readonly SignalMark[] {
  return entity.signals
    .filter((signal) => ATTENTION.has(healthBucket(signal.healthState)))
    .map((signal) => ({ name: signal.displayName || signal.name, value: formatSignalValue(signal.value) || "no data", state: healthBucket(signal.healthState) }))
    .sort((left, right) => severity(left.state) - severity(right.state));
}

/** How many signals an entity has in each state, worst state first; states with none are left out. */
export function signalCounts(entity: Entity): readonly SignalCount[] {
  const counts = new Map<HealthState, number>();
  for (const signal of entity.signals) {
    const state = healthBucket(signal.healthState);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return HEALTH_SORT_ORDER.filter((state) => counts.has(state)).map((state) => ({ state, count: counts.get(state) as number }));
}

interface Graph {
  readonly byName: ReadonlyMap<string, Entity>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly parents: ReadonlyMap<string, readonly string[]>;
}

/** Relationships between two different entities of the model, each pair once, in the order given. */
function graphOf(entities: readonly Entity[], relationships: readonly Relationship[]): Graph {
  const byName = new Map(entities.map((entity) => [entity.name, entity] as const));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const pairs = new Set<string>();
  for (const { parentEntityName: parent, childEntityName: child } of relationships) {
    if (parent === child || !byName.has(parent) || !byName.has(child) || pairs.has(`${parent}\n${child}`)) continue;
    pairs.add(`${parent}\n${child}`);
    children.set(parent, [...(children.get(parent) ?? []), child]);
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  }
  return { byName, children, parents };
}

/** What each entity reaches below it, once, whatever cycles the data holds. */
function descendantsOf(graph: Graph, name: string): ReadonlySet<string> {
  const found = new Set<string>();
  const pending = [...(graph.children.get(name) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (next === name || found.has(next)) continue;
    found.add(next);
    pending.push(...(graph.children.get(next) ?? []));
  }
  return found;
}

interface Below {
  readonly count: number;
  readonly trouble: number;
  /** Something at or below the entity needs attention. */
  readonly attention: boolean;
}

function belowOf(graph: Graph, name: string): Below {
  const reach = descendantsOf(graph, name);
  let trouble = 0;
  for (const item of reach) if (ATTENTION.has(healthBucket((graph.byName.get(item) as Entity).healthState))) trouble += 1;
  const own = ATTENTION.has(healthBucket((graph.byName.get(name) as Entity).healthState));
  return { count: reach.size, trouble, attention: own || trouble > 0 };
}

interface Tree {
  readonly graph: Graph;
  readonly roots: readonly string[];
  readonly below: ReadonlyMap<string, Below>;
  readonly sorted: (names: readonly string[]) => string[];
}

/**
 * The walk's starting points: the model's own root first (the one with the most below it), then
 * the other parts worst first. Entities that only reach each other in a cycle have no root, so the
 * walk later starts at them as well.
 */
function treeOf(entities: readonly Entity[], relationships: readonly Relationship[]): Tree {
  const graph = graphOf(entities, relationships);
  const below = new Map(entities.map((entity) => [entity.name, belowOf(graph, entity.name)] as const));
  const byEntity = (left: string, right: string): number => compareEntities(graph.byName.get(left) as Entity, graph.byName.get(right) as Entity);
  const sorted = (names: readonly string[]): string[] => [...names].sort(byEntity);
  const roots = entities.filter((entity) => !graph.parents.has(entity.name)).map((entity) => entity.name).sort(byEntity);
  const main = [...roots].sort((left, right) => (below.get(right)?.count ?? 0) - (below.get(left)?.count ?? 0) || byEntity(left, right))[0];
  return { graph, roots: main === undefined ? roots : [main, ...roots.filter((name) => name !== main)], below, sorted };
}

function openByDefault(tree: Tree, name: string): boolean {
  return name === tree.roots[0] || (tree.below.get(name)?.attention ?? false);
}

/**
 * The rows of the outline, top to bottom. Children come worst first at every level. A subtree is
 * open when something in it needs attention, or when the viewer opened it (`overrides` holds the
 * viewer's choices by entity name, true for open); the model's root is open unless the viewer
 * closed it. An entity with several parents is a full row under the first parent the walk reaches
 * and an `also` row under the others, so no entity is drawn twice in full and a cycle ends.
 */
export function outlineRows(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  overrides: ReadonlyMap<string, boolean> = new Map(),
  dimmed: ReadonlySet<string> = new Set(),
): readonly OutlineRow[] {
  const tree = treeOf(entities, relationships);
  const { graph } = tree;
  const rows: OutlineRow[] = [];
  const placed = new Map<string, string | null>();

  const visit = (name: string, parentKey: string | null, level: number, position: number, setSize: number): void => {
    const entity = graph.byName.get(name) as Entity;
    const failing = failingSignals(entity);
    const common = {
      entity,
      parentKey,
      level,
      position,
      setSize,
      failing,
      counts: signalCounts(entity),
      dimmed: dimmed.has(name),
      height: failing.length > 0 ? ROW_HEIGHT_WITH_SIGNALS : ROW_HEIGHT,
    };
    if (placed.has(name)) {
      rows.push({ ...common, key: `also:${parentKey ?? ""}:${name}`, kind: "also", expandable: false, open: false, below: 0, belowTrouble: 0, shownUnder: placed.get(name) ?? null, failing: [], height: ROW_HEIGHT });
      return;
    }
    placed.set(name, parentKey);
    const children = tree.sorted(graph.children.get(name) ?? []);
    const open = children.length > 0 && (overrides.get(name) ?? openByDefault(tree, name));
    const below = tree.below.get(name) as Below;
    rows.push({ ...common, key: name, kind: "entity", expandable: children.length > 0, open, below: below.count, belowTrouble: below.trouble, shownUnder: null });
    if (!open) return;
    children.forEach((child, index) => visit(child, name, level + 1, index + 1, children.length));
  };

  const start = (names: readonly string[]): void => names.forEach((name, index) => visit(name, null, 1, index + 1, names.length));
  start(tree.roots);
  // Entities that reach only each other: nothing above them, so start at each in turn.
  for (const entity of [...entities].sort(compareEntities)) if (!placed.has(entity.name) && !hasPlacedAncestor(graph, entity.name, placed)) visit(entity.name, null, 1, 1, 1);
  return rows;
}

/** An unplaced entity under a collapsed parent is reached later by opening it, so it is no root. */
function hasPlacedAncestor(graph: Graph, name: string, placed: ReadonlyMap<string, unknown>): boolean {
  const seen = new Set<string>([name]);
  const pending = [...(graph.parents.get(name) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (placed.has(next)) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(graph.parents.get(next) ?? []));
  }
  return false;
}

/** Every entity with children open: the viewer's "expand all". */
export function expandAllOverrides(entities: readonly Entity[], relationships: readonly Relationship[]): ReadonlyMap<string, boolean> {
  const graph = graphOf(entities, relationships);
  return new Map([...graph.children.keys()].map((name) => [name, true] as const));
}

/**
 * `overrides` with the ancestors of `names` opened, along each one's first parents, so those
 * entities are in the outline. Ancestors that are open already are left as they are.
 */
export function revealOverrides(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  overrides: ReadonlyMap<string, boolean>,
  names: readonly string[],
): ReadonlyMap<string, boolean> {
  const tree = treeOf(entities, relationships);
  const next = new Map(overrides);
  for (const name of names) {
    const seen = new Set<string>([name]);
    let current = name;
    for (let parent = tree.graph.parents.get(current)?.[0]; parent !== undefined && !seen.has(parent); parent = tree.graph.parents.get(current)?.[0]) {
      seen.add(parent);
      if (!(next.get(parent) ?? openByDefault(tree, parent))) next.set(parent, true);
      current = parent;
    }
  }
  return next;
}

export type NavigationKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * The row a navigation key moves to from row `from`, as the ARIA tree pattern has it: arrows step
 * through the visible rows, Right goes to the first child of an open row, Left to the parent, and
 * Home and End to the ends. A key that has nowhere to go stays on the row.
 */
export function navigate(rows: readonly OutlineRow[], from: number, key: NavigationKey): number {
  const last = rows.length - 1;
  const current = rows[from];
  if (current === undefined) return Math.min(Math.max(from, 0), Math.max(last, 0));
  switch (key) {
    case "ArrowDown":
      return Math.min(from + 1, last);
    case "ArrowUp":
      return Math.max(from - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowRight":
      return current.open && rows[from + 1]?.parentKey === current.key ? from + 1 : from;
    case "ArrowLeft": {
      const parent = rows.findIndex((row) => row.key === current.parentKey);
      return parent < 0 ? from : parent;
    }
  }
}

/**
 * The row a typed prefix selects: the next row after `from`, wrapping round, whose name starts with
 * it. A prefix the current row already matches stays on it once it is longer than one character,
 * so typing a word narrows down instead of moving on.
 */
export function typeAheadRow(rows: readonly OutlineRow[], from: number, prefix: string): number {
  const wanted = prefix.toLocaleLowerCase();
  if (wanted === "" || rows.length === 0) return from;
  const matches = (row: OutlineRow): boolean => labelOf(row.entity).startsWith(wanted);
  if (wanted.length > 1 && rows[from] !== undefined && matches(rows[from] as OutlineRow)) return from;
  for (let step = 1; step <= rows.length; step += 1) {
    const index = (from + step) % rows.length;
    if (matches(rows[index] as OutlineRow)) return index;
  }
  return from;
}

/** Where each row starts, from the top of the list; one more entry gives the total height. */
export function rowOffsets(rows: readonly OutlineRow[]): readonly number[] {
  const offsets: number[] = [0];
  for (const row of rows) offsets.push((offsets[offsets.length - 1] as number) + row.height);
  return offsets;
}

/** The row at a height in the list: the last one that starts at or above it. */
export function rowAtOffset(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] as number) <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** A stretch of the problem ribbon: neighbouring rows in one state are one mark. */
export interface RibbonRun {
  readonly y: number;
  readonly height: number;
  readonly state: HealthState;
}

/** One mark per row, coloured by its entity's state, in list coordinates; same-state neighbours merge. */
export function ribbonRuns(rows: readonly OutlineRow[]): readonly RibbonRun[] {
  const runs: RibbonRun[] = [];
  let y = 0;
  for (const row of rows) {
    const state = healthBucket(row.entity.healthState);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.state === state) runs[runs.length - 1] = { ...last, height: last.height + row.height };
    else runs.push({ y, height: row.height, state });
    y += row.height;
  }
  return runs;
}

export interface OutlineSummary {
  readonly rows: number;
  readonly entities: number;
  readonly references: number;
  readonly needAttention: number;
}

export function summarise(rows: readonly OutlineRow[]): OutlineSummary {
  const entities = rows.filter((row) => row.kind === "entity");
  return {
    rows: rows.length,
    entities: entities.length,
    references: rows.length - entities.length,
    needAttention: entities.filter((row) => ATTENTION.has(healthBucket(row.entity.healthState))).length,
  };
}
