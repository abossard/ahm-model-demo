import type { LayoutId, NodeSize, Point } from "./layout";
import type { ModelSelection } from "./types";

/**
 * The custom order a viewer gave a graph by dragging cards. What a layout can keep differs, so an
 * order is kept per model and per family of layouts:
 *
 * - `hierarchy`: the four directions of the hierarchy layout, which share their ranks;
 * - `elk-layered`: the layers of ELK layered;
 * - `elk-radial` and `force`: layouts without ranks, where a card can only take the place of
 *   another, so the order is where every card stands.
 *
 * The live force layout has no places to keep: it is a simulation.
 */
export type OrderFamily = "hierarchy" | "elk-layered" | "elk-radial" | "force";

/** Entity names per rank, in reading order: left to right, or top to bottom when ranks run sideways. */
export interface RankOrder {
  readonly kind: "ranks";
  readonly ranks: readonly (readonly string[])[];
}

/** Where every entity stands: the places a layout produced, handed round. */
export interface SlotOrder {
  readonly kind: "slots";
  readonly slots: Readonly<Record<string, Point>>;
}

export type CustomOrder = RankOrder | SlotOrder;

/** Every order a viewer has kept, by `orderKey`. */
export type CustomOrders = Readonly<Record<string, CustomOrder>>;

const FAMILIES: Readonly<Partial<Record<LayoutId, OrderFamily>>> = {
  "dagre-tb": "hierarchy",
  "dagre-bt": "hierarchy",
  "dagre-lr": "hierarchy",
  "dagre-rl": "hierarchy",
  "elk-layered": "elk-layered",
  "elk-radial": "elk-radial",
  "d3-force": "force",
};

/** The family of a layout, or null when its cards have no places to keep (the live force layout). */
export function familyOf(layout: LayoutId): OrderFamily | null {
  return FAMILIES[layout] ?? null;
}

export function kindOf(family: OrderFamily): CustomOrder["kind"] {
  return family === "hierarchy" || family === "elk-layered" ? "ranks" : "slots";
}

/** What an order is stored under: the model, as the address names it, and the family. */
export function orderKey(model: ModelSelection | null, family: OrderFamily): string | null {
  return model === null ? null : `${model.subscriptionId}/${model.resourceGroup}/${model.name}#${family}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Keeping it                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const STORAGE_KEY = "ahm.customOrders.v1";
const SORT_STORAGE_KEY = "ahm.sortKey.v1";
const MAX_STORED = 40;

function isPoint(value: unknown): value is Point {
  return typeof value === "object" && value !== null && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);
}

function sanitize(value: unknown): CustomOrder | null {
  if (typeof value !== "object" || value === null) return null;
  const order = value as { kind?: unknown; ranks?: unknown; slots?: unknown };
  if (order.kind === "ranks" && Array.isArray(order.ranks)) {
    const ranks = order.ranks.map((row) => (Array.isArray(row) ? row.filter((name): name is string => typeof name === "string") : null));
    return ranks.every((row) => row !== null) ? { kind: "ranks", ranks: ranks as string[][] } : null;
  }
  if (order.kind === "slots" && typeof order.slots === "object" && order.slots !== null) {
    const entries = Object.entries(order.slots).filter((entry): entry is [string, Point] => isPoint(entry[1]));
    return { kind: "slots", slots: Object.fromEntries(entries.map(([name, point]) => [name, { x: point.x, y: point.y }])) };
  }
  return null;
}

/** What storage holds, as far as it is an order; anything else in it is left out. */
export function readStoredOrders(getStorage: () => Storage): CustomOrders {
  try {
    const parsed: unknown = JSON.parse(getStorage().getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    const found: Record<string, CustomOrder> = {};
    for (const [key, value] of Object.entries(parsed).slice(0, MAX_STORED)) {
      const order = sanitize(value);
      if (order) found[key] = order;
    }
    return found;
  } catch {
    return {};
  }
}

export function persistOrders(orders: CustomOrders, getStorage: () => Storage): void {
  try {
    getStorage().setItem(STORAGE_KEY, JSON.stringify(orders));
  } catch {
    // The orders then last only as long as the page does.
  }
}

/** The order key the viewer last chose, so that Custom is still chosen after a reload. */
export function readStoredSortKey(getStorage: () => Storage): string | null {
  try {
    return getStorage().getItem(SORT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistSortKey(key: string, getStorage: () => Storage): void {
  try {
    getStorage().setItem(SORT_STORAGE_KEY, key);
  } catch {
    // The choice then lasts only as long as the page does.
  }
}

/** An order without the entities that are gone. Ranks keep their places, even when they are left empty. */
export function reconcile(order: CustomOrder, present: ReadonlySet<string>): CustomOrder {
  if (order.kind === "ranks") return { kind: "ranks", ranks: order.ranks.map((row) => row.filter((name) => present.has(name))) };
  return { kind: "slots", slots: Object.fromEntries(Object.entries(order.slots).filter(([name]) => present.has(name))) };
}

/* ------------------------------------------------------------------------------------------ */
/* Ranks: where a card may go                                                                  */
/* ------------------------------------------------------------------------------------------ */

type Ranks = readonly (readonly string[])[];

interface Link {
  readonly parentEntityName: string;
  readonly childEntityName: string;
}

/** What the moves of ranks need to know about the graph the ranks are of. */
interface Shape {
  readonly rankOf: ReadonlyMap<string, number>;
  readonly indexOf: ReadonlyMap<string, number>;
  readonly parents: ReadonlyMap<string, readonly string[]>;
  readonly partOf: ReadonlyMap<string, string>;
}

function shapeOf(ranks: Ranks, links: readonly Link[]): Shape {
  const rankOf = new Map<string, number>();
  const indexOf = new Map<string, number>();
  ranks.forEach((row, rank) => row.forEach((name, index) => {
    rankOf.set(name, rank);
    indexOf.set(name, index);
  }));
  const parents = new Map<string, string[]>();
  const leader = new Map([...rankOf.keys()].map((name) => [name, name] as const));
  const find = (name: string): string => {
    let current = name;
    while (leader.get(current) !== current) {
      leader.set(current, leader.get(leader.get(current) as string) as string);
      current = leader.get(current) as string;
    }
    return current;
  };
  for (const { parentEntityName: parent, childEntityName: child } of links) {
    if (parent === child || !rankOf.has(parent) || !rankOf.has(child)) continue;
    const list = parents.get(child) ?? [];
    if (!list.includes(parent)) parents.set(child, [...list, parent]);
    leader.set(find(parent), find(child));
  }
  return { rankOf, indexOf, parents, partOf: new Map([...rankOf.keys()].map((name) => [name, find(name)] as const)) };
}

/** The parts in the order their roots stand in the first rank; the first is the main part. */
function partsInOrder(ranks: Ranks, shape: Shape): string[] {
  return [...new Set((ranks[0] ?? []).map((name) => shape.partOf.get(name) as string))];
}

/** The parent a card follows when its parent moves: the one nearest to it across the rank above. */
function ownerOf(ranks: Ranks, shape: Shape, name: string): string | undefined {
  const rank = shape.rankOf.get(name) as number;
  const above = (shape.parents.get(name) ?? []).filter((parent) => (shape.rankOf.get(parent) as number) < rank);
  if (above.length === 0) return undefined;
  const nearest = Math.max(...above.map((parent) => shape.rankOf.get(parent) as number));
  const fraction = (item: string): number => ((shape.indexOf.get(item) as number) + 0.5) / (ranks[shape.rankOf.get(item) as number] as readonly string[]).length;
  return above
    .filter((parent) => shape.rankOf.get(parent) === nearest)
    .sort((left, right) => Math.abs(fraction(left) - fraction(name)) - Math.abs(fraction(right) - fraction(name)) || (left < right ? -1 : 1))[0];
}

/** What a card can do in a drag: stay among the cards beside it, or, as the root of a part on the shelf, move its part. */
export interface Slots {
  readonly rank: number;
  /** Where it is now: an index in its rank, or the place of its part among the parts of the shelf. */
  readonly from: number;
  /** Every index it may take, in order, the one it has included. A card with only its own is not draggable. */
  readonly indices: readonly number[];
  /** True when the whole part moves: the card is the root of a part that is shelved after the main one. */
  readonly part: boolean;
}

/**
 * The places a card may take. A card with one parent stays among its siblings, so what is drawn
 * under another parent never changes parent. A card with several parents, or with none, may take
 * any place among the cards of its own part in its rank. The root of a part on the shelf moves
 * the part, among the other shelved parts; the main part stays first.
 */
export function slotsFor(ranks: Ranks, links: readonly Link[], name: string): Slots | null {
  const shape = shapeOf(ranks, links);
  const rank = shape.rankOf.get(name);
  const from = shape.indexOf.get(name);
  if (rank === undefined || from === undefined) return null;
  const row = ranks[rank] as readonly string[];
  const parts = partsInOrder(ranks, shape);
  const part = shape.partOf.get(name) as string;
  if (rank === 0 && part !== parts[0]) {
    const shelved = parts.slice(1);
    return { rank, from: shelved.indexOf(part), indices: shelved.map((_item, index) => index), part: true };
  }
  const parents = shape.parents.get(name) ?? [];
  const sameGroup = (other: string): boolean =>
    parents.length === 1 ? (shape.parents.get(other) ?? []).includes(parents[0] as string) : shape.partOf.get(other) === part;
  const members = row.flatMap((other, index) => (sameGroup(other) ? [index] : []));
  const low = Math.min(...members);
  const high = Math.max(...members);
  return { rank, from, indices: Array.from({ length: high - low + 1 }, (_item, offset) => low + offset), part: false };
}

/** `row` with the cards in `fixed` in the places they hold, in the order given; the other cards keep theirs. */
function fill(row: readonly string[], fixed: readonly string[]): string[] {
  const held = new Set(fixed);
  let next = 0;
  return row.map((name) => (held.has(name) ? (fixed[next++] as string) : name));
}

/**
 * The ranks with `name` taken to `index` in its rank, and what follows it with it: each card
 * below goes with the parent it follows (see `ownerOf`), so a parent takes its subtree along and a
 * shared child goes with the nearest of its parents. For the root of a shelved part, `index` is
 * the place among the shelved parts and the whole part moves. Out of range indices are clamped to
 * what `slotsFor` allows.
 */
export function moveTo(ranks: Ranks, links: readonly Link[], name: string, index: number): string[][] {
  const slots = slotsFor(ranks, links, name);
  const copy = ranks.map((row) => [...row]);
  if (!slots) return copy;
  const to = Math.min(Math.max(index, slots.indices[0] as number), slots.indices[slots.indices.length - 1] as number);
  const shape = shapeOf(ranks, links);

  if (slots.part) {
    const parts = partsInOrder(ranks, shape);
    const moved = shape.partOf.get(name) as string;
    const shelved = parts.slice(1).filter((part) => part !== moved);
    shelved.splice(to, 0, moved);
    const order = [parts[0] as string, ...shelved];
    return ranks.map((row) => order.flatMap((part) => row.filter((item) => shape.partOf.get(item) === part)));
  }

  const row = copy[slots.rank] as string[];
  row.splice(slots.from, 1);
  row.splice(to, 0, name);
  let anchors = new Map(row.map((item, position) => [item, position] as const));
  for (let rank = slots.rank + 1; rank < ranks.length; rank += 1) {
    const old = ranks[rank] as readonly string[];
    const mine = new Map<string, number>();
    for (const item of old) {
      const owner = ownerOf(ranks, shape, item);
      const anchor = owner === undefined ? undefined : anchors.get(owner);
      if (anchor !== undefined) mine.set(item, anchor);
    }
    if (mine.size === 0) break;
    const sorted = old.filter((item) => mine.has(item)).sort((left, right) => (mine.get(left) as number) - (mine.get(right) as number) || (shape.indexOf.get(left) as number) - (shape.indexOf.get(right) as number));
    copy[rank] = fill(old, sorted);
    anchors = mine;
  }
  return copy;
}

/** Ranks read off the positions of a layout: cards whose tops (or lefts) are level are a rank, in reading order. */
export function ranksFromPositions(
  positions: ReadonlyMap<string, Point>,
  axis: "x" | "y",
): string[][] {
  const rows = new Map<number, string[]>();
  for (const [name, point] of positions) {
    const key = Math.round(axis === "x" ? point.y : point.x);
    rows.set(key, [...(rows.get(key) ?? []), name]);
  }
  const across = (name: string): number => {
    const point = positions.get(name) as Point;
    return axis === "x" ? point.x : point.y;
  };
  return [...rows.entries()].sort((left, right) => left[0] - right[0]).map(([, names]) => names.sort((left, right) => across(left) - across(right) || (left < right ? -1 : 1)));
}

/* ------------------------------------------------------------------------------------------ */
/* Slots: swapping places                                                                      */
/* ------------------------------------------------------------------------------------------ */

function overlaps(a: Point, aSize: NodeSize, b: Point, bSize: NodeSize, gap: number): boolean {
  return a.x < b.x + bSize.width + gap && b.x < a.x + aSize.width + gap && a.y < b.y + bSize.height + gap && b.y < a.y + aSize.height + gap;
}

/** What two cards swapping places leave: each centred where the other was, or null when one would land on a third card. */
export function swapped(
  positions: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize>,
  first: string,
  second: string,
): Map<string, Point> | null {
  const a = positions.get(first);
  const b = positions.get(second);
  const sa = sizes.get(first);
  const sb = sizes.get(second);
  if (!a || !b || !sa || !sb || first === second) return null;
  const centre = (point: Point, size: NodeSize): Point => ({ x: point.x + size.width / 2, y: point.y + size.height / 2 });
  const ca = centre(a, sa);
  const cb = centre(b, sb);
  const next = new Map(positions);
  next.set(first, { x: cb.x - sa.width / 2, y: cb.y - sa.height / 2 });
  next.set(second, { x: ca.x - sb.width / 2, y: ca.y - sb.height / 2 });
  for (const mover of [first, second]) {
    const at = next.get(mover) as Point;
    const size = sizes.get(mover) as NodeSize;
    for (const [other, point] of next) {
      if (other === mover || other === (mover === first ? second : first)) continue;
      if (overlaps(at, size, point, sizes.get(other) ?? { width: 0, height: 0 }, 8)) return null;
    }
  }
  return overlaps(next.get(first) as Point, sa, next.get(second) as Point, sb, 8) ? null : next;
}

/** The cards `name` can swap places with without landing on another card, nearest first. */
export function swapTargets(positions: ReadonlyMap<string, Point>, sizes: ReadonlyMap<string, NodeSize>, name: string): string[] {
  const here = positions.get(name);
  if (!here) return [];
  const distance = (other: string): number => {
    const point = positions.get(other) as Point;
    return Math.hypot(point.x - here.x, point.y - here.y);
  };
  return [...positions.keys()]
    .filter((other) => other !== name && swapped(positions, sizes, name, other) !== null)
    .sort((left, right) => distance(left) - distance(right) || (left < right ? -1 : 1));
}
