import type { Rect } from "./edgeRouting";
import { TOP, forLayout, impose, swapTargets, swapped, withChain, withPlaces, type ModelOrder, type OrderFamily, type PlaceFamily } from "./customOrder";
import { arrange } from "./arrange";
import { LAYOUT_ENGINES, type GraphLayout, type LayoutId, type NodeSize, type Point } from "./layout";
import { orderWithinRanks } from "./ordering";
import type { Entity, Relationship } from "./types";

/**
 * What a view offers a drag: the things it draws side by side, and where. Every view describes
 * itself this way, so one set of rules decides where a thing may go and what order a drop leaves.
 */
export interface ReorderWorld {
  /** What is drawn side by side, in reading order: the cards of a rank or of a lane's row, the children of a parent. */
  readonly rows: readonly (readonly string[])[];
  /** Where each thing is drawn, in the view's own coordinates. */
  readonly rects: ReadonlyMap<string, Rect>;
  /**
   * The parents each thing that can be moved is drawn under; none for the top level. A thing that
   * is not listed holds its place: a count tile, a chip, a card on the chain of a cause.
   */
  readonly parents: ReadonlyMap<string, readonly string[]>;
  /** The entity a thing stands for, where its id is not the entity's name. */
  readonly entityOf?: (id: string) => string;
  /** Set for a layout whose cards have places and no order: a card swaps places with another. */
  readonly places?: PlaceFamily;
}

interface Link {
  readonly parentEntityName: string;
  readonly childEntityName: string;
}

/** The parents each of `movable` is drawn under: its parents among `drawn`, each once. */
export function drawnParents(movable: Iterable<string>, drawn: ReadonlySet<string>, links: readonly Link[]): Map<string, readonly string[]> {
  const parents = new Map<string, string[]>([...movable].map((id) => [id, []]));
  for (const { parentEntityName: parent, childEntityName: child } of links) {
    const list = parents.get(child);
    if (list && parent !== child && drawn.has(parent) && !list.includes(parent)) list.push(parent);
  }
  return parents;
}

/**
 * Where a dragged thing would land. `index` is a place in its row, one that it or one of the
 * things it shares a parent with holds; `swap` is the card whose place it takes.
 */
export type Candidate =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "swap"; readonly target: string };

export type StepKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/** How far past the things it may trade places with a drop still counts as one among them. */
export const DROP_MARGIN = 72;

/** The places a thing may take in its row. */
export interface Places {
  readonly row: readonly string[];
  /** Every index it may take, in order, the one it has included. A thing with only its own cannot be moved. */
  readonly slots: readonly number[];
  readonly from: number;
}

function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function boxOf(rects: readonly Rect[]): Rect {
  const x1 = Math.min(...rects.map((rect) => rect.x));
  const y1 = Math.min(...rects.map((rect) => rect.y));
  const x2 = Math.max(...rects.map((rect) => rect.x + rect.width));
  const y2 = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function within(point: Point, rect: Rect, margin: number): boolean {
  return point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;
}

/**
 * The places a thing may take: its own and those of the things in its row that share a parent
 * with it, or, at the top level, of the others that have none. So what is drawn under one parent
 * never changes parent, and a card never leaves its rank, its lane or its row.
 */
export function placesOf(world: ReorderWorld, id: string): Places | null {
  const mine = world.parents.get(id);
  const row = world.rows.find((items) => items.includes(id));
  if (mine === undefined || row === undefined) return null;
  const peer = (other: string): boolean => {
    const theirs = world.parents.get(other);
    if (theirs === undefined) return false;
    return other === id || (mine.length === 0 ? theirs.length === 0 : theirs.some((parent) => mine.includes(parent)));
  };
  const slots = row.flatMap((other, index) => (peer(other) ? [index] : []));
  return { row, slots, from: row.indexOf(id) };
}

function swapsOf(world: ReorderWorld, id: string): readonly string[] {
  if (!world.parents.has(id)) return [];
  const positions = new Map([...world.rects].map(([item, rect]) => [item, { x: rect.x, y: rect.y }] as const));
  const sizes = new Map([...world.rects].map(([item, rect]) => [item, { width: rect.width, height: rect.height }] as const));
  return swapTargets(positions, sizes, id);
}

/** The places a drag of `id` can end at, in the order the keyboard walks them. */
export function candidatesOf(world: ReorderWorld, id: string): readonly Candidate[] {
  if (world.places) return swapsOf(world, id).map((target): Candidate => ({ kind: "swap", target }));
  const places = placesOf(world, id);
  return places && places.slots.length > 1 ? places.slots.map((index): Candidate => ({ kind: "index", index })) : [];
}

/** Where the thing is now, as a candidate: what a drag that goes nowhere comes to. Null where cards swap places. */
export function currentCandidate(world: ReorderWorld, id: string): Candidate | null {
  if (world.places) return null;
  const places = placesOf(world, id);
  return places ? { kind: "index", index: places.from } : null;
}

/**
 * The place the pointer, at `centre` (the middle of the dragged copy), is over; null when it is
 * over none the view allows. In a row that is the place of the nearest thing it may trade with,
 * within a margin of them all; where cards swap places, the card whose place can be taken.
 */
export function candidateAt(world: ReorderWorld, id: string, centre: Point): Candidate | null {
  if (world.places) {
    let best: { target: string; distance: number } | null = null;
    for (const target of swapsOf(world, id)) {
      const rect = world.rects.get(target) as Rect;
      if (!within(centre, rect, DROP_MARGIN / 3)) continue;
      const middle = centreOf(rect);
      const distance = Math.hypot(middle.x - centre.x, middle.y - centre.y);
      if (best === null || distance < best.distance) best = { target, distance };
    }
    return best === null ? null : { kind: "swap", target: best.target };
  }

  const places = placesOf(world, id);
  if (!places || places.slots.length < 2) return null;
  const rects = places.slots.map((index) => world.rects.get(places.row[index] as string)).filter((rect): rect is Rect => rect !== undefined);
  if (rects.length !== places.slots.length || !within(centre, boxOf(rects), DROP_MARGIN)) return null;
  let best = { index: places.from, distance: Number.POSITIVE_INFINITY };
  places.slots.forEach((index, at) => {
    const middle = centreOf(rects[at] as Rect);
    const distance = Math.hypot(middle.x - centre.x, middle.y - centre.y);
    if (distance < best.distance) best = { index, distance };
  });
  return { kind: "index", index: best.index };
}

/** True when the candidate leaves things as they are. */
export function isNoOp(world: ReorderWorld, id: string, candidate: Candidate): boolean {
  const current = currentCandidate(world, id);
  return candidate.kind === "index" && current?.kind === "index" && current.index === candidate.index;
}

/**
 * The candidate after one arrow key: Left and Up go to the previous place of a row, Right and
 * Down to the next. Where cards swap places they go to the nearest card in that direction, from
 * where the card or the candidate is. Null when there is nowhere to go; the candidate stays.
 */
export function stepCandidate(world: ReorderWorld, id: string, from: Candidate | null, key: StepKey): Candidate | null {
  const options = candidatesOf(world, id);
  if (options.length === 0) return null;
  if (world.places) {
    const here = from?.kind === "swap" ? (world.rects.get(from.target) as Rect) : (world.rects.get(id) as Rect);
    const origin = centreOf(here);
    const vector = key === "ArrowLeft" ? { x: -1, y: 0 } : key === "ArrowRight" ? { x: 1, y: 0 } : key === "ArrowUp" ? { x: 0, y: -1 } : { x: 0, y: 1 };
    let best: { option: Candidate; score: number } | null = null;
    for (const option of options) {
      if (option.kind !== "swap" || (from?.kind === "swap" && option.target === from.target)) continue;
      const middle = centreOf(world.rects.get(option.target) as Rect);
      const dx = middle.x - origin.x;
      const dy = middle.y - origin.y;
      const ahead = dx * vector.x + dy * vector.y;
      if (ahead <= 0) continue;
      const score = Math.hypot(dx, dy) + 1.5 * Math.abs(dx * vector.y - dy * vector.x);
      if (best === null || score < best.score) best = { option, score };
    }
    return best === null ? null : best.option;
  }
  const indices = options.flatMap((option) => (option.kind === "index" ? [option.index] : []));
  const current = from?.kind === "index" ? from.index : (currentCandidate(world, id) as { index: number }).index;
  const next = key === "ArrowLeft" || key === "ArrowUp" ? indices.filter((index) => index < current).pop() : indices.find((index) => index > current);
  return next === undefined ? null : { kind: "index", index: next };
}

/** The row with the thing taken to `index`: it and the things it may trade with keep the places they hold between them. */
export function rowAfter(world: ReorderWorld, id: string, index: number): string[] {
  const places = placesOf(world, id);
  if (!places) return [];
  const to = places.slots.indexOf(index);
  if (to < 0) return [...places.row];
  const peers = places.slots.map((slot) => places.row[slot] as string).filter((other) => other !== id);
  peers.splice(to, 0, id);
  return impose(places.row, peers);
}

/**
 * The order a drop keeps, on top of the order `base` that is drawn: for a place in a row, the
 * children of each parent of the thing, as the row then has them; for a swap, the places of the
 * layout with the two cards swapped. Null when nothing would change.
 */
export function orderAfter(world: ReorderWorld, base: ModelOrder | null, id: string, candidate: Candidate): ModelOrder | null {
  if (candidate.kind === "swap") {
    if (!world.places) return null;
    const positions = new Map([...world.rects].map(([item, rect]) => [item, { x: rect.x, y: rect.y }] as const));
    const sizes = new Map([...world.rects].map(([item, rect]) => [item, { width: rect.width, height: rect.height }] as const));
    const next = swapped(positions, sizes, id, candidate.target);
    return next ? withPlaces(base, world.places, Object.fromEntries(next)) : null;
  }
  const mine = world.parents.get(id);
  if (mine === undefined || isNoOp(world, id, candidate)) return null;
  const row = rowAfter(world, id, candidate.index);
  const entityOf = world.entityOf ?? ((item: string): string => item);
  let order = base;
  for (const parent of mine.length === 0 ? [TOP] : mine) {
    const children = row.filter((other) => {
      const theirs = world.parents.get(other);
      return theirs !== undefined && (parent === TOP ? theirs.length === 0 : theirs.includes(parent));
    });
    order = withChain(order, parent, children.map(entityOf));
  }
  return order;
}

/** What a candidate means on screen, for an announcement. */
export function describeMove(world: ReorderWorld, id: string, candidate: Candidate, labelOf: (id: string) => string = (item) => item): string {
  if (candidate.kind === "swap") return `Swap places with ${labelOf(candidate.target)}.`;
  const places = placesOf(world, id);
  if (!places) return "";
  return `Place ${places.slots.indexOf(candidate.index) + 1} of ${places.slots.length}.`;
}

/**
 * Where every card of the card graph would stand if `order` were kept, for a drag to show as it
 * goes. The hierarchy is arranged again with the order, so it is exactly what a drop gives; ELK
 * layered only opens the place in the rank, as its layers are laid out by the engine once the card
 * is dropped; the places of the other layouts are the ones in the order. `ranks` are the ranks
 * the layout made by itself.
 */
export function previewPositions(
  layoutId: LayoutId,
  family: OrderFamily,
  order: ModelOrder,
  ranks: readonly (readonly string[])[],
  current: GraphLayout,
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizes: ReadonlyMap<string, NodeSize>,
): ReadonlyMap<string, Point> {
  const custom = forLayout(family, order, ranks, relationships);
  if (custom === null) return current.positions;
  if (custom.kind === "slots") return new Map([...current.positions].map(([name, point]) => [name, custom.slots[name] ?? point] as const));
  if (layoutId === "elk-layered") return orderWithinRanks(current, custom.ranks.flat(), "x", sizes).positions;
  const nodes = entities.map((entity) => ({ name: entity.name, ...(sizes.get(entity.name) ?? { width: 0, height: 0 }) }));
  return arrange(nodes, relationships, LAYOUT_ENGINES[layoutId].flow as "tb" | "bt" | "lr" | "rl", { order: custom.ranks }).positions;
}
