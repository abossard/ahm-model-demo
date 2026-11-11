import type { Rect } from "./edgeRouting";
import { kindOf, moveTo, slotsFor, swapTargets, swapped, type CustomOrder, type OrderFamily } from "./customOrder";
import { arrange } from "./arrange";
import { LAYOUT_ENGINES, type GraphLayout, type LayoutId, type NodeSize, type Point } from "./layout";
import { orderWithinRanks } from "./ordering";
import type { Entity, Relationship } from "./types";

/** The axis a rank is read along: left to right is `x`, top to bottom is `y`. */
export type Axis = "x" | "y";

type Ranks = readonly (readonly string[])[];

interface Link {
  readonly parentEntityName: string;
  readonly childEntityName: string;
}

/** What a drag has to go on: where the cards are drawn now, and what the layout can do with them. */
export interface DragWorld {
  readonly family: OrderFamily;
  readonly rects: ReadonlyMap<string, Rect>;
  readonly links: readonly Link[];
  /** For layouts with ranks: the entities of each rank in reading order. */
  readonly ranks: Ranks;
  readonly axis: Axis;
}

/**
 * Where a dragged card would land. `index` is the place in its rank, or, for the root of a part on
 * the shelf, the place of the part among the shelved parts; `swap` is the card whose place it takes.
 */
export type Candidate =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "swap"; readonly target: string };

export type StepKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

/** How far past the cards of a rank, and past the rank itself, a drop still counts as one on it. */
export const DROP_MARGIN = 72;

function acrossOf(rect: Rect, axis: Axis): number {
  return axis === "x" ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
}

function startOf(rect: Rect, axis: Axis): number {
  return axis === "x" ? rect.x : rect.y;
}

function endOf(rect: Rect, axis: Axis): number {
  return axis === "x" ? rect.x + rect.width : rect.y + rect.height;
}

const other = (axis: Axis): Axis => (axis === "x" ? "y" : "x");

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

function distanceTo(point: Point, rect: Rect): number {
  return Math.hypot(Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width), Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height));
}

/** The shelved parts, in shelf order, each as the names it has. */
function shelvedParts(world: DragWorld): string[][] {
  const first = world.ranks[0] ?? [];
  const part = new Map<string, string>();
  const leader = new Map([...world.rects.keys()].map((name) => [name, name] as const));
  const find = (name: string): string => {
    let current = name;
    while (leader.get(current) !== current) {
      leader.set(current, leader.get(leader.get(current) as string) as string);
      current = leader.get(current) as string;
    }
    return current;
  };
  for (const link of world.links) {
    if (leader.has(link.parentEntityName) && leader.has(link.childEntityName)) leader.set(find(link.parentEntityName), find(link.childEntityName));
  }
  for (const name of leader.keys()) part.set(name, find(name));
  const order: string[] = [];
  for (const name of first) {
    const id = part.get(name);
    if (id !== undefined && !order.includes(id)) order.push(id);
  }
  return order.slice(1).map((id) => [...part].filter(([, owner]) => owner === id).map(([name]) => name));
}

/** The cards a drag of `name` can end beside or on, in the order the keyboard walks them. */
export function candidatesOf(world: DragWorld, name: string): readonly Candidate[] {
  if (kindOf(world.family) === "slots") {
    const positions = new Map([...world.rects].map(([item, rect]) => [item, { x: rect.x, y: rect.y }] as const));
    const sizes = new Map([...world.rects].map(([item, rect]) => [item, { width: rect.width, height: rect.height }] as const));
    return swapTargets(positions, sizes, name).map((target): Candidate => ({ kind: "swap", target }));
  }
  const slots = slotsFor(world.ranks, world.links, name);
  return slots && slots.indices.length > 1 ? slots.indices.map((index): Candidate => ({ kind: "index", index })) : [];
}

/** Where the card is now, as a candidate: what a drag that goes nowhere comes to. Null for layouts with no ranks to be in. */
export function currentCandidate(world: DragWorld, name: string): Candidate | null {
  if (kindOf(world.family) === "slots") return null;
  const slots = slotsFor(world.ranks, world.links, name);
  return slots ? { kind: "index", index: slots.from } : null;
}

/**
 * The place the pointer, at `centre` (the middle of the dragged card), is over; null when it is
 * over none the layout allows. In a layout with ranks that is a place in the card's own rank,
 * among the cards it may be among, within a margin of the rank; for the root of a shelved part, the
 * shelved part it is over. Elsewhere it is the card whose place can be taken.
 */
export function candidateAt(world: DragWorld, name: string, centre: Point): Candidate | null {
  if (kindOf(world.family) === "slots") {
    const options = candidatesOf(world, name);
    let best: { target: string; distance: number } | null = null;
    for (const option of options) {
      if (option.kind !== "swap") continue;
      const rect = world.rects.get(option.target) as Rect;
      if (!within(centre, rect, DROP_MARGIN / 3)) continue;
      const distance = Math.hypot(rect.x + rect.width / 2 - centre.x, rect.y + rect.height / 2 - centre.y);
      if (best === null || distance < best.distance) best = { target: option.target, distance };
    }
    return best === null ? null : { kind: "swap", target: best.target };
  }

  const slots = slotsFor(world.ranks, world.links, name);
  if (!slots || slots.indices.length < 2) return null;
  const axis = world.axis;

  if (slots.part) {
    const parts = shelvedParts(world);
    let best: { index: number; distance: number } | null = null;
    parts.forEach((names, index) => {
      const box = boxOf(names.map((item) => world.rects.get(item) as Rect));
      if (!within(centre, box, DROP_MARGIN / 2)) return;
      const distance = distanceTo(centre, box);
      if (best === null || distance < best.distance) best = { index, distance };
    });
    return best === null ? null : { kind: "index", index: (best as { index: number }).index };
  }

  const row = world.ranks[slots.rank] as readonly string[];
  const rects = row.map((item) => world.rects.get(item) as Rect);
  const band = boxOf(rects);
  const along = other(axis);
  if (centre[along] < startOf(band, along) - DROP_MARGIN || centre[along] > endOf(band, along) + DROP_MARGIN) return null;
  const low = slots.indices[0] as number;
  const high = slots.indices[slots.indices.length - 1] as number;
  const span = rects.slice(low, high + 1);
  const spanStart = Math.min(...span.map((rect) => startOf(rect, axis)));
  const spanEnd = Math.max(...span.map((rect) => endOf(rect, axis)));
  if (centre[axis] < spanStart - DROP_MARGIN || centre[axis] > spanEnd + DROP_MARGIN) return null;
  const before = row.filter((item) => item !== name && acrossOf(world.rects.get(item) as Rect, axis) < centre[axis]).length;
  return { kind: "index", index: Math.min(Math.max(before, low), high) };
}

/** True when the candidate leaves things as they are. */
export function isNoOp(world: DragWorld, name: string, candidate: Candidate): boolean {
  const current = currentCandidate(world, name);
  return candidate.kind === "index" && current?.kind === "index" && current.index === candidate.index;
}

/**
 * The candidate after one arrow key: Left and Up go to the previous place of a rank, Right and
 * Down to the next. Without ranks they go to the nearest card in that direction, from where the
 * card or the candidate is. Null when there is nowhere to go; the candidate stays.
 */
export function stepCandidate(world: DragWorld, name: string, from: Candidate | null, key: StepKey): Candidate | null {
  const options = candidatesOf(world, name);
  if (options.length === 0) return null;
  if (kindOf(world.family) === "slots") {
    const here = from?.kind === "swap" ? (world.rects.get(from.target) as Rect) : (world.rects.get(name) as Rect);
    const origin = { x: here.x + here.width / 2, y: here.y + here.height / 2 };
    const vector = key === "ArrowLeft" ? { x: -1, y: 0 } : key === "ArrowRight" ? { x: 1, y: 0 } : key === "ArrowUp" ? { x: 0, y: -1 } : { x: 0, y: 1 };
    let best: { option: Candidate; score: number } | null = null;
    for (const option of options) {
      if (option.kind !== "swap" || (from?.kind === "swap" && option.target === from.target)) continue;
      const rect = world.rects.get(option.target) as Rect;
      const dx = rect.x + rect.width / 2 - origin.x;
      const dy = rect.y + rect.height / 2 - origin.y;
      const ahead = dx * vector.x + dy * vector.y;
      if (ahead <= 0) continue;
      const score = Math.hypot(dx, dy) + 1.5 * Math.abs(dx * vector.y - dy * vector.x);
      if (best === null || score < best.score) best = { option, score };
    }
    return best === null ? null : best.option;
  }
  const indices = options.flatMap((option) => (option.kind === "index" ? [option.index] : []));
  const current = from?.kind === "index" ? from.index : (currentCandidate(world, name) as { index: number }).index;
  const next = key === "ArrowLeft" || key === "ArrowUp" ? indices.filter((index) => index < current).pop() : indices.find((index) => index > current);
  return next === undefined ? null : { kind: "index", index: next };
}

/** The order a drop keeps: ranks with the card moved, or the places with two cards swapped. Null when nothing would change. */
export function orderAfter(world: DragWorld, name: string, candidate: Candidate, sizes: ReadonlyMap<string, NodeSize>): CustomOrder | null {
  if (candidate.kind === "swap") {
    const positions = new Map([...world.rects].map(([item, rect]) => [item, { x: rect.x, y: rect.y }] as const));
    const next = swapped(positions, sizes, name, candidate.target);
    return next ? { kind: "slots", slots: Object.fromEntries(next) } : null;
  }
  if (isNoOp(world, name, candidate)) return null;
  return { kind: "ranks", ranks: moveTo(world.ranks, world.links, name, candidate.index) };
}

/** What each ArrowKey means on screen, for an announcement. */
export function describeMove(world: DragWorld, name: string, candidate: Candidate): string {
  if (candidate.kind === "swap") return `Swap places with ${candidate.target}.`;
  const slots = slotsFor(world.ranks, world.links, name);
  if (!slots) return "";
  const low = slots.indices[0] as number;
  const total = slots.indices.length;
  return slots.part ? `Place ${candidate.index + 1} of ${total} among the parts on the shelf.` : `Place ${candidate.index - low + 1} of ${total}.`;
}

/**
 * Where every card would stand if `order` were kept, for a drag to show as it goes. The hierarchy
 * is arranged again with the order, so it is exactly what a drop gives; ELK layered only opens the
 * place in the rank, as its layers are laid out by the engine once the card is dropped; the places
 * of the other layouts are the ones in the order.
 */
export function previewPositions(
  layoutId: LayoutId,
  order: CustomOrder,
  current: GraphLayout,
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  sizes: ReadonlyMap<string, NodeSize>,
): ReadonlyMap<string, Point> {
  if (order.kind === "slots") return new Map([...current.positions].map(([name, point]) => [name, order.slots[name] ?? point] as const));
  if (layoutId === "elk-layered") return orderWithinRanks(current, order.ranks.flat(), "x", sizes).positions;
  const nodes = entities.map((entity) => ({ name: entity.name, ...(sizes.get(entity.name) ?? { width: 0, height: 0 }) }));
  return arrange(nodes, relationships, LAYOUT_ENGINES[layoutId].flow as "tb" | "bt" | "lr" | "rl", { order: order.ranks }).positions;
}
