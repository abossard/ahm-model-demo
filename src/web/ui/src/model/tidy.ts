import { arrange } from "./arrange";
import { healthBucket } from "./collapse";
import { linkKey } from "./compare";
import type { Point } from "./layout";
import { HEALTH_SORT_ORDER } from "./ordering";
import { routeSteps, type Rect } from "./stepRouter";
import type { Entity, HealthState, Relationship } from "./types";

/** Every entity is a tile of this size, so a row of tiles is a column grid and nothing has to be measured. */
export const TILE = { width: 216, height: 76 } as const;
/** An opened fold keeps a chip this size, to fold it again. */
export const CHIP = { width: 132, height: 30 } as const;
/** Above this many entities in view, healthy leaves fold into one count tile per parent. */
export const FOLD_ABOVE = 40;
/** Fewest healthy leaves that fold: one leaf folded would only hide a name. */
export const MIN_FOLD = 2;
/** Most signal glyphs a tile shows; the rest are a count. */
export const SIGNAL_GLYPHS = 6;

const SHELF_PAD = { side: 14, top: 42, bottom: 14 } as const;
const FOLD_PREFIX = "fold:";

/** Close enough to the 10.5 px label font; the router only needs room for the pill. */
function labelWidthOf(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length * 5.9 + 14);
}

/** Healthy leaves under one parent, drawn as one count tile until the viewer opens them. */
export interface Fold {
  readonly id: string;
  readonly parent: string;
  readonly members: readonly string[];
  readonly open: boolean;
}

/**
 * The folds for a model in view. A leaf folds when it is Healthy, has no children, one parent, and
 * is not in `keep` (selected, highlighted, on the chain, marked or changed); a parent folds its
 * leaves when it has at least `MIN_FOLD`. Small models fold nothing: they fit and show every name.
 * `open` names the parents whose fold the viewer opened.
 */
export function planFolds(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  keep: ReadonlySet<string>,
  open: ReadonlySet<string>,
): readonly Fold[] {
  if (entities.length <= FOLD_ABOVE) return [];
  const byName = new Map(entities.map((entity) => [entity.name, entity] as const));
  const children = new Map<string, number>();
  const parents = new Map<string, string[]>();
  const pairs = new Set<string>();
  for (const { parentEntityName: parent, childEntityName: child } of relationships) {
    if (parent === child || !byName.has(parent) || !byName.has(child) || pairs.has(`${parent}\n${child}`)) continue;
    pairs.add(`${parent}\n${child}`);
    children.set(parent, (children.get(parent) ?? 0) + 1);
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  }
  const groups = new Map<string, string[]>();
  for (const entity of entities) {
    const owners = parents.get(entity.name) ?? [];
    if (healthBucket(entity.healthState) !== "Healthy" || children.has(entity.name) || owners.length !== 1 || keep.has(entity.name)) continue;
    groups.set(owners[0] as string, [...(groups.get(owners[0] as string) ?? []), entity.name]);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= MIN_FOLD)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([parent, members]) => ({ id: `${FOLD_PREFIX}${parent}`, parent, members: members.sort(), open: open.has(parent) }));
}

export type TidyNode =
  | { readonly kind: "entity"; readonly id: string; readonly rect: Rect }
  | { readonly kind: "fold"; readonly id: string; readonly rect: Rect; readonly fold: Fold };

export interface TidyEdge {
  /** The relationship's name, or the fold's id for the line to a fold. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly Point[];
  readonly label: Point | null;
  readonly text: string;
}

export interface TidyLayout {
  /** In reading order: row by row, left to right, which is the keyboard focus order. */
  readonly nodes: readonly TidyNode[];
  readonly edges: readonly TidyEdge[];
  /** Frames round the parts that are not connected to the root. */
  readonly shelves: readonly Rect[];
  readonly bounds: Rect;
}

/** What one side of a Compare draws of an arrangement made for both. */
export interface TidyOnly {
  readonly entities: ReadonlySet<string>;
  /** The relationships it has, as `linkKey(parent, child)`. */
  readonly links: ReadonlySet<string>;
}

export interface TidyInput {
  /** What is arranged: the entities left by the Health filter and the collapsed entities. */
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  readonly folds: readonly Fold[];
  /** The whole model, to tell the parts that are connected to the root from the others. */
  readonly whole: { readonly entities: readonly Entity[]; readonly relationships: readonly Relationship[] };
  /**
   * In Compare, both sides are arranged together and each draws only what it has, in the place
   * the shared arrangement gives it. A fold keeps the members this side has and is gone when none
   * is left; a frame round unconnected parts is drawn only where a tile of it is.
   */
  readonly only?: TidyOnly;
  /** The order a viewer gave the hierarchy by dragging, as `arrange` keeps it: entity names per rank. */
  readonly order?: readonly (readonly string[])[];
}

/** Which connected part of the whole model each entity belongs to; the root's part is the largest. */
function partsOf(whole: TidyInput["whole"]): { readonly partOf: ReadonlyMap<string, string>; readonly main: string | null } {
  const leader = new Map(whole.entities.map((entity) => [entity.name, entity.name] as const));
  const find = (name: string): string => {
    let current = name;
    while (leader.get(current) !== current) {
      leader.set(current, leader.get(leader.get(current) as string) as string);
      current = leader.get(current) as string;
    }
    return current;
  };
  for (const { parentEntityName: parent, childEntityName: child } of whole.relationships) {
    if (leader.has(parent) && leader.has(child)) leader.set(find(parent), find(child));
  }
  const members = new Map<string, string[]>();
  for (const entity of whole.entities) members.set(find(entity.name), [...(members.get(find(entity.name)) ?? []), entity.name]);
  const largest = [...members.entries()].sort(([leftId, left], [rightId, right]) => right.length - left.length || leftId.localeCompare(rightId))[0];
  // One entity alone is no root: without a tree there is nothing the others are not connected to.
  return { partOf: new Map(whole.entities.map((entity) => [entity.name, find(entity.name)] as const)), main: largest !== undefined && largest[1].length >= 2 ? largest[0] : null };
}

function unionOf(rects: readonly Rect[]): Rect {
  const x1 = Math.min(...rects.map((rect) => rect.x));
  const y1 = Math.min(...rects.map((rect) => rect.y));
  const x2 = Math.max(...rects.map((rect) => rect.x + rect.width));
  const y2 = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const EMPTY: TidyLayout = { nodes: [], edges: [], shelves: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };

/**
 * Arranges the entities in rows with `arrange` (parents centred over children, few crossings),
 * routes step lines with `routeSteps` (no line through a tile, spread ports where several parents
 * meet, label pills near the child), and frames the parts that are not connected to the root.
 * Closed folds replace their members with one count tile; an open fold keeps a chip beside them.
 */
export function tidyLayout(input: TidyInput): TidyLayout {
  const hidden = new Set(input.folds.filter((fold) => !fold.open).flatMap((fold) => fold.members));
  const drawn = input.entities.filter((entity) => !hidden.has(entity.name));
  if (drawn.length === 0) return EMPTY;
  const byName = new Map(drawn.map((entity) => [entity.name, entity] as const));
  const sizeOfFold = (fold: Fold): { readonly width: number; readonly height: number } => (fold.open ? CHIP : TILE);

  const used = new Set<string>();
  const edges: { readonly id: string; readonly from: string; readonly to: string; readonly text: string; readonly weight: number }[] = [];
  for (const relationship of input.relationships) {
    const { parentEntityName: from, childEntityName: to } = relationship;
    if (from === to || !byName.has(from) || !byName.has(to)) continue;
    let id = relationship.name;
    for (let copy = 2; used.has(id); copy += 1) id = `${relationship.name}#${copy}`;
    used.add(id);
    edges.push({ id, from, to, text: relationship.displayName ?? "", weight: HEALTH_SORT_ORDER.length - HEALTH_SORT_ORDER.indexOf(healthBucket((byName.get(to) as Entity).healthState)) });
  }
  for (const fold of input.folds) edges.push({ id: fold.id, from: fold.parent, to: fold.id, text: "", weight: 0 });

  const sizes = new Map<string, { readonly width: number; readonly height: number }>([
    ...drawn.map((entity) => [entity.name, TILE] as const),
    ...input.folds.map((fold) => [fold.id, sizeOfFold(fold)] as const),
  ]);
  const arrangement = arrange(
    [...sizes].map(([name, size]) => ({ name, ...size })),
    edges.map((edge) => ({ parentEntityName: edge.from, childEntityName: edge.to, displayName: edge.text })),
    "tb",
    input.order ? { order: input.order } : {},
  );
  const routing = routeSteps(
    [...sizes].map(([id, size]) => ({ id, ...(arrangement.positions.get(id) as Point), ...size })),
    edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, labelWidth: labelWidthOf(edge.text), weight: edge.weight })),
  );

  const only = input.only;
  const folds = new Map(input.folds.map((fold) => [fold.id, only ? { ...fold, members: fold.members.filter((name) => only.entities.has(name)) } : fold] as const));
  const order = [...new Set([...arrangement.ranks.flat(), ...sizes.keys()])];
  const nodes = order
    .map((id): TidyNode => {
      const rect = routing.nodes.get(id) as Rect;
      const fold = folds.get(id);
      return fold ? { kind: "fold", id, rect, fold } : { kind: "entity", id, rect };
    })
    .filter((node) => (only === undefined ? true : node.kind === "fold" ? node.fold.members.length > 0 : only.entities.has(node.id)));
  const present = new Set(nodes.map((node) => node.id));
  const lines = routing.edges
    .filter((edge) => only === undefined || (present.has(edge.from) && present.has(edge.to) && (folds.has(edge.to) || only.links.has(linkKey(edge.from, edge.to)))))
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, points: edge.points, label: edge.label, text: edges.find((item) => item.id === edge.id)?.text ?? "" }));

  const { partOf, main } = partsOf(input.whole);
  const partOfNode = (id: string): string | undefined => partOf.get(folds.get(id)?.parent ?? id);
  const shelves: Rect[] = [];
  if (main !== null) {
    const framed = new Set(nodes.map((node) => partOfNode(node.id)).filter((part): part is string => part !== undefined && part !== main));
    for (const part of [...framed].sort()) {
      const inside = nodes.filter((node) => partOfNode(node.id) === part).map((node) => node.rect);
      const around = lines.filter((line) => partOfNode(line.from) === part).flatMap((line) => line.points.map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 })));
      const box = unionOf([...inside, ...around]);
      shelves.push({ x: box.x - SHELF_PAD.side, y: box.y - SHELF_PAD.top, width: box.width + 2 * SHELF_PAD.side, height: box.height + SHELF_PAD.top + SHELF_PAD.bottom });
    }
  }
  return { nodes, edges: lines, shelves, bounds: unionOf([routing.bounds, ...shelves]) };
}

/** What the signal row of a tile shows: one glyph per signal, worst first, and how many did not fit. */
export interface TileSignals {
  readonly glyphs: readonly HealthState[];
  readonly more: number;
  readonly total: number;
}

export function tileSignals(entity: Entity, max: number = SIGNAL_GLYPHS): TileSignals {
  const states = entity.signals
    .map((signal) => healthBucket(signal.healthState))
    .sort((left, right) => HEALTH_SORT_ORDER.indexOf(left) - HEALTH_SORT_ORDER.indexOf(right));
  return { glyphs: states.slice(0, max), more: Math.max(0, states.length - max), total: states.length };
}

/**
 * The entities to open a large model on: the first one that needs attention and its parent, so
 * the view starts at the problem instead of at a root with nothing in sight to read. The worst
 * state wins (Unhealthy, then Degraded), among those with nothing worse below them, then the
 * earlier in `order`. With nothing Degraded or Unhealthy it is the first Unknown; with none, empty.
 */
export function firstProblem(entities: readonly Entity[], relationships: readonly Relationship[], order: readonly string[]): readonly string[] {
  const place = new Map(order.map((name, index) => [name, index] as const));
  const bucket = new Map(entities.map((entity) => [entity.name, healthBucket(entity.healthState)] as const));
  const loud = (name: string): boolean => bucket.get(name) === "Unhealthy" || bucket.get(name) === "Degraded";
  const parents = new Map<string, string[]>();
  const loudBelow = new Set<string>();
  for (const { parentEntityName: parent, childEntityName: child } of relationships) {
    if (!bucket.has(parent) || !bucket.has(child) || parent === child) continue;
    parents.set(child, [...(parents.get(child) ?? []), parent]);
    if (loud(child)) loudBelow.add(parent);
  }
  let candidates = entities.filter((entity) => loud(entity.name) && !loudBelow.has(entity.name));
  if (candidates.length === 0) candidates = entities.filter((entity) => bucket.get(entity.name) === "Unknown");
  const first = [...candidates].sort(
    (left, right) =>
      HEALTH_SORT_ORDER.indexOf(bucket.get(left.name) as HealthState) - HEALTH_SORT_ORDER.indexOf(bucket.get(right.name) as HealthState) ||
      (place.get(left.name) ?? Infinity) - (place.get(right.name) ?? Infinity) ||
      left.name.localeCompare(right.name),
  )[0];
  if (first === undefined) return [];
  const parent = [...(parents.get(first.name) ?? [])].sort((left, right) => (place.get(left) ?? Infinity) - (place.get(right) ?? Infinity))[0];
  return parent === undefined ? [first.name] : [first.name, parent];
}
