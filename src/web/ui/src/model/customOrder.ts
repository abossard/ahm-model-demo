import type { LayoutId, NodeSize, Point } from "./layout";
import type { ModelSelection } from "./types";

/**
 * The custom order a viewer gave a health model by dragging. There is one per model and every view
 * reads it.
 *
 * It is a list of chains. A chain names entities in the order the viewer left them: the children
 * of one parent (`of`), or the entities with no parent (`TOP`). Wherever a view draws entities of
 * a chain side by side (the children of a parent in a tree, the cards of a rank or of a lane's
 * row), they stand in the chain's order and take the places they hold between them; an entity no
 * chain names stays where the view's own order puts it. A later chain wins over an earlier one.
 *
 * Two layouts of the card graph have places and no order (ELK radial and the force layout): the
 * places a viewer swapped there are kept beside the chains, per layout. The live force layout is
 * a simulation and keeps nothing.
 */
export interface Chain {
  /** The parent whose children these are, or `TOP`. */
  readonly of: string;
  readonly names: readonly string[];
}

export type PlaceFamily = "elk-radial" | "force";

export interface ModelOrder {
  readonly chains: readonly Chain[];
  readonly places: Readonly<Partial<Record<PlaceFamily, Readonly<Record<string, Point>>>>>;
}

/** The chain of the entities that have no parent. */
export const TOP = "";

export const EMPTY_ORDER: ModelOrder = { chains: [], places: {} };

/** Every order a viewer has kept, by `orderKey`. */
export type CustomOrders = Readonly<Record<string, ModelOrder>>;

/**
 * What a layout of the card graph can keep, and so what its engine is handed:
 *
 * - `hierarchy` and `elk-layered`: entity names per rank, in reading order;
 * - `elk-radial` and `force`: where every card stands.
 */
export type OrderFamily = "hierarchy" | "elk-layered" | PlaceFamily;

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

/** What an order is stored under: the model, as the address names it. */
export function orderKey(model: ModelSelection | null): string | null {
  return model === null ? null : `${model.subscriptionId}/${model.resourceGroup}/${model.name}`;
}

/** True when the order holds anything a view would show. */
export function hasOrder(order: ModelOrder | null | undefined): boolean {
  return order !== null && order !== undefined && (order.chains.length > 0 || Object.keys(order.places).length > 0);
}

/* ------------------------------------------------------------------------------------------ */
/* Keeping it                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const STORAGE_KEY = "ahm.customOrders.v2";
/** Before every view shared one order, an order was kept per model and family of layouts: `<model>#<family>`. */
const FAMILY_STORAGE_KEY = "ahm.customOrders.v1";
const SORT_STORAGE_KEY = "ahm.sortKey.v1";
const MAX_STORED = 40;

function isPoint(value: unknown): value is Point {
  return typeof value === "object" && value !== null && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);
}

function namesOf(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : null;
}

function placesOf(value: unknown): Record<string, Point> | null {
  if (typeof value !== "object" || value === null) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, Point] => isPoint(entry[1]));
  return Object.fromEntries(entries.map(([name, point]) => [name, { x: point.x, y: point.y }]));
}

function sanitize(value: unknown): ModelOrder | null {
  if (typeof value !== "object" || value === null) return null;
  const order = value as { chains?: unknown; places?: unknown };
  if (!Array.isArray(order.chains)) return null;
  const chains: Chain[] = [];
  for (const item of order.chains as { of?: unknown; names?: unknown }[]) {
    const names = namesOf(item?.names);
    if (typeof item?.of === "string" && names) chains.push({ of: item.of, names });
  }
  const places: Partial<Record<PlaceFamily, Record<string, Point>>> = {};
  for (const family of ["elk-radial", "force"] as const) {
    const found = placesOf((order.places as Record<string, unknown> | undefined)?.[family]);
    if (found) places[family] = found;
  }
  return { chains, places };
}

/**
 * The orders kept per family, as one order per model. The rows of a hierarchy or of ELK layered
 * are chains as they are: their cards stood side by side in that order. The hierarchy's come
 * last, so they win where the two disagree. Places stay places.
 */
function fromFamilies(parsed: Record<string, unknown>): CustomOrders {
  const found: Record<string, ModelOrder> = {};
  const families: readonly OrderFamily[] = ["elk-layered", "hierarchy", "elk-radial", "force"];
  for (const family of families) {
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.endsWith(`#${family}`) || typeof value !== "object" || value === null) continue;
      const model = key.slice(0, key.length - family.length - 1);
      const before = found[model] ?? EMPTY_ORDER;
      const kept = value as { kind?: unknown; ranks?: unknown; slots?: unknown };
      if (family === "elk-radial" || family === "force") {
        const places = kept.kind === "slots" ? placesOf(kept.slots) : null;
        if (places) found[model] = { ...before, places: { ...before.places, [family]: places } };
        continue;
      }
      if (kept.kind !== "ranks" || !Array.isArray(kept.ranks)) continue;
      const rows = kept.ranks.map(namesOf);
      if (rows.some((row) => row === null)) continue;
      const chains = (rows as string[][]).flatMap((names, rank) => (names.length > 1 ? [{ of: `#${family}:${rank}`, names }] : []));
      found[model] = { ...before, chains: [...before.chains, ...chains] };
    }
  }
  return found;
}

/** What storage holds, as far as it is an order; anything else in it is left out. Orders kept per family are read as one. */
export function readStoredOrders(getStorage: () => Storage): CustomOrders {
  try {
    const current = getStorage().getItem(STORAGE_KEY);
    const parsed: unknown = JSON.parse(current ?? getStorage().getItem(FAMILY_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    if (current === null) return Object.fromEntries(Object.entries(fromFamilies(parsed as Record<string, unknown>)).slice(0, MAX_STORED));
    const found: Record<string, ModelOrder> = {};
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

/* ------------------------------------------------------------------------------------------ */
/* Reading it: the order of things drawn side by side                                          */
/* ------------------------------------------------------------------------------------------ */

/** `row` with the names `chain` has in the places they hold between them, in the chain's order; the others keep theirs. */
export function impose(row: readonly string[], chain: readonly string[]): string[] {
  const drawn = new Set(row);
  const fixed = [...new Set(chain)].filter((name) => drawn.has(name));
  if (fixed.length < 2) return [...row];
  const held = new Set(fixed);
  let next = 0;
  return row.map((name) => (held.has(name) ? (fixed[next++] as string) : name));
}

/** Things drawn side by side, in the order the viewer gave: every chain imposed, the earliest first. */
export function inOrder(row: readonly string[], order: ModelOrder | null | undefined): string[] {
  let result = [...row];
  if (row.length < 2) return result;
  for (const chain of order?.chains ?? []) result = impose(result, chain.names);
  return result;
}

type Ranks = readonly (readonly string[])[];

interface Link {
  readonly parentEntityName: string;
  readonly childEntityName: string;
}

/**
 * The parent a card follows when its parent moves: among its parents in the nearest rank above,
 * the one nearest to it across that rank.
 */
function ownersOf(ranks: Ranks, links: readonly Link[]): ReadonlyMap<string, string> {
  const rankOf = new Map<string, number>();
  const fraction = new Map<string, number>();
  ranks.forEach((row, rank) => row.forEach((name, index) => {
    rankOf.set(name, rank);
    fraction.set(name, (index + 0.5) / row.length);
  }));
  const parents = new Map<string, string[]>();
  for (const { parentEntityName: parent, childEntityName: child } of links) {
    if (parent === child || !rankOf.has(parent) || !rankOf.has(child) || (rankOf.get(parent) as number) >= (rankOf.get(child) as number)) continue;
    const list = parents.get(child) ?? [];
    if (!list.includes(parent)) parents.set(child, [...list, parent]);
  }
  const owners = new Map<string, string>();
  for (const [name, above] of parents) {
    const nearest = Math.max(...above.map((parent) => rankOf.get(parent) as number));
    const away = (parent: string): number => Math.abs((fraction.get(parent) as number) - (fraction.get(name) as number));
    const owner = above.filter((parent) => rankOf.get(parent) === nearest).sort((left, right) => away(left) - away(right) || (left < right ? -1 : 1))[0];
    if (owner !== undefined) owners.set(name, owner);
  }
  return owners;
}

/**
 * The ranks (or the lanes) of a layout in the order the viewer gave. Rank by rank from the top:
 * first each card goes with the parent it follows, so a parent that moved takes what hangs below
 * it along; then every chain is imposed on the rank. A rank no chain touches, under parents that
 * did not move, is returned as it came.
 */
export function ranksInOrder(ranks: Ranks, links: readonly Link[], order: ModelOrder | null | undefined): string[][] {
  if (!order || order.chains.length === 0) return ranks.map((row) => [...row]);
  const owners = ownersOf(ranks, links);
  const before = new Map<string, readonly [number, number]>();
  const after = new Map<string, readonly [number, number]>();
  return ranks.map((row, rank) => {
    const place = new Map(row.map((name, index) => [name, index] as const));
    const led = row.filter((name) => owners.has(name));
    const sortedBy = (places: ReadonlyMap<string, readonly [number, number]>): string[] =>
      [...led].sort((left, right) => {
        const a = places.get(owners.get(left) as string) as readonly [number, number];
        const b = places.get(owners.get(right) as string) as readonly [number, number];
        return a[0] - b[0] || a[1] - b[1] || (place.get(left) as number) - (place.get(right) as number);
      });
    const was = sortedBy(before);
    const now = sortedBy(after);
    const taker = new Map(was.map((name, index) => [name, now[index] as string] as const));
    const result = inOrder(row.map((name) => taker.get(name) ?? name), order);
    row.forEach((name, index) => before.set(name, [rank, index]));
    result.forEach((name, index) => after.set(name, [rank, index]));
    return result;
  });
}

/** True when two sets of ranks have the same cards in the same places. */
export function sameRanks(left: Ranks, right: Ranks): boolean {
  return left.length === right.length && left.every((row, rank) => row.length === right[rank]?.length && row.every((name, index) => name === right[rank]?.[index]));
}

/**
 * What a layout of the card graph is handed for an order: the ranks it laid out by itself, in the
 * viewer's order, or the places kept for it. Null when the order changes nothing for the layout.
 */
export function forLayout(family: OrderFamily, order: ModelOrder | null | undefined, ranks: Ranks, links: readonly Link[]): CustomOrder | null {
  if (!order) return null;
  if (kindOf(family) === "slots") {
    const slots = order.places[family as PlaceFamily];
    return slots ? { kind: "slots", slots } : null;
  }
  if (order.chains.length === 0) return null;
  const wanted = ranksInOrder(ranks, links, order);
  return sameRanks(wanted, ranks) ? null : { kind: "ranks", ranks: wanted };
}

/* ------------------------------------------------------------------------------------------ */
/* Writing it                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * The order with the children of `of` left as `names` has them. Children the chain already had
 * and `names` does not (a view may not draw them all) keep their places in it; the chain becomes
 * the latest, so it wins where an earlier one disagrees.
 */
export function withChain(order: ModelOrder | null | undefined, of: string, names: readonly string[]): ModelOrder {
  const base = order ?? EMPTY_ORDER;
  const known = base.chains.find((chain) => chain.of === of)?.names ?? [];
  const merged = impose(known, names);
  names.forEach((name, index) => {
    if (merged.includes(name)) return;
    const previous = names[index - 1];
    merged.splice(previous === undefined ? 0 : merged.indexOf(previous) + 1, 0, name);
  });
  return { ...base, chains: [...base.chains.filter((chain) => chain.of !== of), { of, names: merged }] };
}

/** The order with the places of one layout that has places and no order. */
export function withPlaces(order: ModelOrder | null | undefined, family: PlaceFamily, places: Readonly<Record<string, Point>>): ModelOrder {
  const base = order ?? EMPTY_ORDER;
  return { ...base, places: { ...base.places, [family]: places } };
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
