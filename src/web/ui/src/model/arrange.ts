import type { LayoutFlow, Rect } from "./edgeRouting";
import type { GraphLayout, NodeSize, Point } from "./layout";
import type { Relationship } from "./types";

export type ArrangeDirection = Exclude<LayoutFlow, "free">;

export interface ArrangeNode extends NodeSize {
  readonly name: string;
}

export interface ArrangeEdge {
  readonly parentEntityName: string;
  readonly childEntityName: string;
  /** The text drawn on the connection; labels that would overlap count against an arrangement. */
  readonly displayName?: Relationship["displayName"];
}

export interface Arrangement extends GraphLayout {
  /**
   * Entity names per rank, rank 0 being the roots. Each connected part contributes its own row, the
   * largest part first, in reading order across the ranks (left to right for top-down and
   * bottom-up, top to bottom for left-to-right and right-to-left).
   */
  readonly ranks: readonly (readonly string[])[];
}

export interface ArrangementScore {
  /** Cards, other than its own two, that the drawn route of a relationship passes through. */
  readonly throughCards: number;
  /** Pairs of relationships without a shared entity whose drawn routes touch or cross. */
  readonly crossings: number;
  /** Total length of the drawn routes. */
  readonly length: number;
  /** Spread across the ranks: the box width for top-down and bottom-up, its height otherwise. */
  readonly width: number;
  /** Total distance between each parent and the middle of its children. */
  readonly offCentre: number;
  /** Pairs of connection labels that overlap, each label at the middle of its route. */
  readonly labelClashes: number;
}

// Same clearances as the dagre layouts these arrangements replace.
const NODE_GAP = 48;
const RANK_GAP = 72;
const MARGIN = 24;
/** Clearance beside the vertical channel of a relationship that skips ranks. */
const CHANNEL_GAP = 24;
/** What a stand-in for a long edge weighs against a card when a rank is projected. */
const CHANNEL_WEIGHT = 32;
const SWEEPS = 24;
const STALL_LIMIT = 4;
const TRANSPOSE_PASSES = 8;
const ROUNDS = 12;
const WARM_ROUNDS = 6;
const EPSILON = 1e-6;
const VIEW = { width: 16, height: 9 };
/** What a defect costs, in pixels of route length. */
const THROUGH_CARD_PRICE = 10000;
const CROSSING_PRICE = 2000;
/** How much search a card that routes pass through gets, in entities and relationships tried. */
const UNBLOCK_WORK = 1500;
/** A parent off the middle of its children costs more than its distance, so trees come out tidy. */
const OFF_CENTRE_PRICE = 10;
const LABEL_CLASH_PRICE = 3000;
/** Size of a connection label: 10.5 px text plus the padding of its background. */
const LABEL_LETTER = 6;
const LABEL_PADDING = 16;
const LABEL_HEIGHT = 20;

/** Parent, child and the width of the label drawn on the connection, if it has one. */
type Link = readonly [parent: number, child: number, label?: number];

function labelWidth(text: string | null | undefined): number {
  return text ? text.length * LABEL_LETTER + LABEL_PADDING : 0;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------ */
/* Score                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function put(segments: Float64Array, at: number, x1: number, y1: number, x2: number, y2: number): void {
  segments[at] = Math.min(x1, x2);
  segments[at + 1] = Math.min(y1, y2);
  segments[at + 2] = Math.max(x1, x2);
  segments[at + 3] = Math.max(y1, y2);
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((values[middle] as number) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Scores rects in top-down space. A relationship is drawn from the parent's bottom to the child's
 * top: down to the middle between the two ports, across, down again. Each route is three boxes
 * with no thickness, and two axis-aligned segments touch exactly when their boxes overlap. The
 * cards that routes pass through are added to `hit`. A label sits at the middle of its route; for
 * left-to-right and right-to-left (`flat`) its text runs along the other axis of this space.
 */
function scoreRoutes(rects: readonly Rect[], links: readonly Link[], flat: boolean, hit?: Set<number>): ArrangementScore {
  const count = links.length;
  const segments = new Float64Array(count * 12);
  const parts = new Uint8Array(count);
  const bounds = new Float64Array(count * 4);
  const lowest = new Float64Array(rects.length).fill(Number.POSITIVE_INFINITY);
  const highest = new Float64Array(rects.length).fill(Number.NEGATIVE_INFINITY);
  let length = 0;
  links.forEach(([parent, child], route) => {
    const from = rects[parent] as Rect;
    const to = rects[child] as Rect;
    const fromX = from.x + from.width / 2;
    const toX = to.x + to.width / 2;
    const fromY = from.y + from.height;
    length += Math.abs(to.y - fromY) + Math.abs(toX - fromX);
    lowest[parent] = Math.min(lowest[parent] as number, toX);
    highest[parent] = Math.max(highest[parent] as number, toX);
    if (Math.abs(fromX - toX) < EPSILON) {
      put(segments, route * 12, fromX, fromY, fromX, to.y);
      parts[route] = 1;
    } else {
      const middle = (fromY + to.y) / 2;
      put(segments, route * 12, fromX, fromY, fromX, middle);
      put(segments, route * 12 + 4, fromX, middle, toX, middle);
      put(segments, route * 12 + 8, toX, middle, toX, to.y);
      parts[route] = 3;
    }
    put(bounds, route * 4, fromX, fromY, toX, to.y);
  });

  let offCentre = 0;
  rects.forEach((rect, index) => {
    if ((lowest[index] as number) <= (highest[index] as number)) {
      offCentre += Math.abs(rect.x + rect.width / 2 - ((lowest[index] as number) + (highest[index] as number)) / 2);
    }
  });

  const byTop = rects.map((_rect, index) => index).sort((a, b) => (rects[a] as Rect).y - (rects[b] as Rect).y);
  const tops = byTop.map((index) => (rects[index] as Rect).y);
  const tallest = rects.reduce((most, rect) => Math.max(most, rect.height), 0);
  let throughCards = 0;
  links.forEach(([parent, child], route) => {
    const left = bounds[route * 4] as number;
    const top = bounds[route * 4 + 1] as number;
    const right = bounds[route * 4 + 2] as number;
    const bottom = bounds[route * 4 + 3] as number;
    for (let at = lowerBound(tops, top - tallest); at < byTop.length && (tops[at] as number) < bottom; at += 1) {
      const card = byTop[at] as number;
      const rect = rects[card] as Rect;
      if (card === parent || card === child) continue;
      if (rect.x >= right || rect.x + rect.width <= left || rect.y + rect.height <= top) continue;
      for (let part = 0; part < (parts[route] as number); part += 1) {
        const base = route * 12 + part * 4;
        if (
          (segments[base] as number) < rect.x + rect.width &&
          rect.x < (segments[base + 2] as number) &&
          (segments[base + 1] as number) < rect.y + rect.height &&
          rect.y < (segments[base + 3] as number)
        ) {
          throughCards += 1;
          hit?.add(card);
          break;
        }
      }
    }
  });

  const byRouteTop = links.map((_link, route) => route).sort((a, b) => (bounds[a * 4 + 1] as number) - (bounds[b * 4 + 1] as number));
  let crossings = 0;
  for (let first = 0; first < count; first += 1) {
    const one = byRouteTop[first] as number;
    const [oneParent, oneChild] = links[one] as Link;
    for (let second = first + 1; second < count; second += 1) {
      const other = byRouteTop[second] as number;
      if ((bounds[other * 4 + 1] as number) > (bounds[one * 4 + 3] as number)) break;
      if ((bounds[one * 4] as number) > (bounds[other * 4 + 2] as number) || (bounds[other * 4] as number) > (bounds[one * 4 + 2] as number)) continue;
      const [otherParent, otherChild] = links[other] as Link;
      if (oneParent === otherParent || oneParent === otherChild || oneChild === otherParent || oneChild === otherChild) continue;
      let touching = false;
      for (let a = 0; a < (parts[one] as number) && !touching; a += 1) {
        for (let b = 0; b < (parts[other] as number); b += 1) {
          const x = one * 12 + a * 4;
          const y = other * 12 + b * 4;
          if (
            (segments[x] as number) <= (segments[y + 2] as number) &&
            (segments[y] as number) <= (segments[x + 2] as number) &&
            (segments[x + 1] as number) <= (segments[y + 3] as number) &&
            (segments[y + 1] as number) <= (segments[x + 3] as number)
          ) {
            touching = true;
            break;
          }
        }
      }
      if (touching) crossings += 1;
    }
  }

  const labels: { x: number; y: number; halfWide: number; halfHigh: number }[] = [];
  links.forEach(([, , label = 0], route) => {
    if (label <= 0) return;
    labels.push({
      x: ((bounds[route * 4] as number) + (bounds[route * 4 + 2] as number)) / 2,
      y: ((bounds[route * 4 + 1] as number) + (bounds[route * 4 + 3] as number)) / 2,
      halfWide: (flat ? LABEL_HEIGHT : label) / 2,
      halfHigh: (flat ? label : LABEL_HEIGHT) / 2,
    });
  });
  labels.sort((a, b) => a.y - b.y);
  const reach = labels.reduce((most, label) => Math.max(most, 2 * label.halfHigh), 0);
  let labelClashes = 0;
  labels.forEach((one, index) => {
    for (const other of labels.slice(index + 1)) {
      if (other.y - one.y >= reach) break;
      if (Math.abs(other.x - one.x) < one.halfWide + other.halfWide && Math.abs(other.y - one.y) < one.halfHigh + other.halfHigh) {
        labelClashes += 1;
      }
    }
  });

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    low = Math.min(low, rect.x);
    high = Math.max(high, rect.x + rect.width);
  }
  return { throughCards, crossings, length, width: rects.length > 0 ? high - low : 0, offCentre, labelClashes };
}

function priceOf(score: ArrangementScore): number {
  return (
    score.throughCards * THROUGH_CARD_PRICE +
    score.crossings * CROSSING_PRICE +
    score.length +
    score.width +
    score.offCentre * OFF_CENTRE_PRICE +
    score.labelClashes * LABEL_CLASH_PRICE
  );
}

/** Negative when `left` is the better arrangement; scores within a pixel count as equal. */
export function compareScores(left: ArrangementScore, right: ArrangementScore): number {
  return Math.round(priceOf(left)) - Math.round(priceOf(right));
}

/** A rectangle in the top-down space the arrangement is computed in. */
function toTopDown(rect: Rect, direction: ArrangeDirection): Rect {
  if (direction === "tb") return rect;
  if (direction === "bt") return { x: rect.x, y: -(rect.y + rect.height), width: rect.width, height: rect.height };
  if (direction === "lr") return { x: rect.y, y: rect.x, width: rect.height, height: rect.width };
  return { x: rect.y, y: -(rect.x + rect.width), width: rect.height, height: rect.width };
}

/** Scores positions the way candidate arrangements are compared; see `compareScores`. */
export function scoreArrangement(
  nodes: readonly ArrangeNode[],
  edges: readonly ArrangeEdge[],
  positions: ReadonlyMap<string, Point>,
  direction: ArrangeDirection,
): ArrangementScore {
  const placed = new Map<string, number>();
  const rects: Rect[] = [];
  for (const node of nodes) {
    const point = positions.get(node.name);
    if (!point || placed.has(node.name)) continue;
    placed.set(node.name, rects.length);
    rects.push(toTopDown({ x: point.x, y: point.y, width: node.width, height: node.height }, direction));
  }
  const labels = new Map<string, number>();
  for (const edge of edges) {
    const parent = placed.get(edge.parentEntityName);
    const child = placed.get(edge.childEntityName);
    if (parent === undefined || child === undefined || parent === child) continue;
    const key = `${parent}:${child}`;
    labels.set(key, Math.max(labels.get(key) ?? 0, labelWidth(edge.displayName)));
  }
  const links: Link[] = [...labels].map(([key, label]) => {
    const [parent = 0, child = 0] = key.split(":").map(Number);
    return [parent, child, label];
  });
  return scoreRoutes(rects, links, direction === "lr" || direction === "rl");
}

/* ------------------------------------------------------------------------------------------ */
/* Graph                                                                                       */
/* ------------------------------------------------------------------------------------------ */

interface Graph {
  readonly names: readonly string[];
  /** Extent across the ranks and along them, per entity, in top-down space. */
  readonly cross: readonly number[];
  readonly along: readonly number[];
  /** Parent and child with the width of the label on it, each pair once, sorted. */
  readonly links: readonly Link[];
  /** Whether ranks run left to right or right to left, which turns the labels on their side. */
  readonly flat: boolean;
}

function extent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function buildGraph(
  nodes: readonly ArrangeNode[],
  edges: readonly ArrangeEdge[],
  direction: ArrangeDirection,
): Graph {
  const sizes = new Map<string, NodeSize>();
  for (const node of nodes) {
    const prior = sizes.get(node.name);
    sizes.set(node.name, {
      width: Math.max(prior?.width ?? 0, extent(node.width)),
      height: Math.max(prior?.height ?? 0, extent(node.height)),
    });
  }
  const names = [...sizes.keys()].sort(compareNames);
  const index = new Map(names.map((name, position) => [name, position] as const));
  const flat = direction === "lr" || direction === "rl";
  const cross = names.map((name) => {
    const size = sizes.get(name) as NodeSize;
    return flat ? size.height : size.width;
  });
  const along = names.map((name) => {
    const size = sizes.get(name) as NodeSize;
    return flat ? size.width : size.height;
  });
  const labels = new Map<number, number>();
  for (const edge of edges) {
    const parent = index.get(edge.parentEntityName);
    const child = index.get(edge.childEntityName);
    if (parent === undefined || child === undefined || parent === child) continue;
    const key = parent * names.length + child;
    labels.set(key, Math.max(labels.get(key) ?? 0, labelWidth(edge.displayName)));
  }
  const links: Link[] = [...labels].map(([key, label]) => [Math.floor(key / names.length), key % names.length, label]);
  links.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return { names, cross, along, links, flat };
}

/** Connected parts as sorted lists of entity indices, the largest first. */
function partsOf(graph: Graph): readonly (readonly number[])[] {
  const count = graph.names.length;
  const root = Array.from({ length: count }, (_unused, index) => index);
  const find = (node: number): number => {
    let top = node;
    while (root[top] !== top) top = root[top] as number;
    let walk = node;
    while (root[walk] !== top) {
      const next = root[walk] as number;
      root[walk] = top;
      walk = next;
    }
    return top;
  };
  for (const [parent, child] of graph.links) {
    const left = find(parent);
    const right = find(child);
    if (left !== right) root[Math.max(left, right)] = Math.min(left, right);
  }
  const parts = new Map<number, number[]>();
  for (let node = 0; node < count; node += 1) {
    const top = find(node);
    const members = parts.get(top);
    if (members) members.push(node);
    else parts.set(top, [node]);
  }
  return [...parts.values()].sort(
    (left, right) => right.length - left.length || (left[0] as number) - (right[0] as number),
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Layers                                                                                      */
/* ------------------------------------------------------------------------------------------ */

interface Layered {
  /** Ids below this are entities; the rest are the stand-ins of relationships that skip ranks. */
  readonly real: number;
  readonly size: number;
  readonly rank: readonly number[];
  readonly up: readonly (readonly number[])[];
  readonly down: readonly (readonly number[])[];
  /** For a stand-in, the entities at the two ends of its relationship. */
  readonly top: readonly number[];
  readonly bottom: readonly number[];
  readonly cross: readonly number[];
}

/**
 * Longest path from the roots. A depth-first walk drops the relationships that close a cycle, so
 * dirty data still gets a drawing; the dropped ones are drawn like any other.
 */
function rankEntities(count: number, links: readonly Link[]): { rank: number[]; forward: Link[] } {
  const children: number[][] = Array.from({ length: count }, () => []);
  const hasParent = new Uint8Array(count);
  for (const [parent, child] of links) {
    (children[parent] as number[]).push(child);
    hasParent[child] = 1;
  }
  const all = Array.from({ length: count }, (_unused, node) => node);
  const state = new Uint8Array(count);
  const forward: Link[] = [];
  for (const start of [...all.filter((node) => !hasParent[node]), ...all]) {
    if (state[start] !== 0) continue;
    state[start] = 1;
    const stack: [number, number][] = [[start, 0]];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as [number, number];
      const list = children[frame[0]] as number[];
      if (frame[1] === list.length) {
        state[frame[0]] = 2;
        stack.pop();
        continue;
      }
      const child = list[frame[1]] as number;
      frame[1] += 1;
      if (state[child] === 1) continue;
      forward.push([frame[0], child]);
      if (state[child] === 0) {
        state[child] = 1;
        stack.push([child, 0]);
      }
    }
  }

  const below: number[][] = Array.from({ length: count }, () => []);
  const pending = new Int32Array(count);
  for (const [parent, child] of forward) {
    (below[parent] as number[]).push(child);
    pending[child] = (pending[child] as number) + 1;
  }
  const rank = new Array<number>(count).fill(0);
  const queue = all.filter((node) => pending[node] === 0);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] as number;
    for (const child of below[node] as number[]) {
      rank[child] = Math.max(rank[child] as number, (rank[node] as number) + 1);
      pending[child] = (pending[child] as number) - 1;
      if (pending[child] === 0) queue.push(child);
    }
  }
  return { rank, forward };
}

function expand(count: number, cross: readonly number[], rank: readonly number[], forward: readonly Link[]): Layered {
  const up: number[][] = Array.from({ length: count }, () => []);
  const down: number[][] = Array.from({ length: count }, () => []);
  const ranks = [...rank];
  const extents = [...cross];
  const top = new Array<number>(count).fill(-1);
  const bottom = new Array<number>(count).fill(-1);
  const join = (parent: number, child: number): void => {
    (down[parent] as number[]).push(child);
    (up[child] as number[]).push(parent);
  };
  const sorted = [...forward].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  for (const [parent, child] of sorted) {
    let previous = parent;
    for (let at = (rank[parent] as number) + 1; at < (rank[child] as number); at += 1) {
      const stand = ranks.length;
      ranks.push(at);
      extents.push(0);
      top.push(parent);
      bottom.push(child);
      up.push([]);
      down.push([]);
      join(previous, stand);
      previous = stand;
    }
    join(previous, child);
  }
  const key = (node: number): number => (node < count ? node : (bottom[node] as number));
  for (const list of down) list.sort((left, right) => key(left) - key(right) || left - right);
  return { real: count, size: ranks.length, rank: ranks, up, down, top, bottom, cross: extents };
}

/* ------------------------------------------------------------------------------------------ */
/* Order inside the ranks                                                                      */
/* ------------------------------------------------------------------------------------------ */

type Seed = "depth-first" | "name";
type Metric = "mean" | "median";

interface Candidate {
  readonly seed: Seed;
  readonly metric: Metric;
}

const CANDIDATES: readonly Candidate[] = [
  { seed: "depth-first", metric: "mean" },
  { seed: "depth-first", metric: "median" },
  { seed: "name", metric: "mean" },
];

function seedLayers(layered: Layered, seed: Seed, rankCount: number): number[][] {
  const layers: number[][] = Array.from({ length: rankCount }, () => []);
  if (seed === "name") {
    const key = (node: number): number => (node < layered.real ? node : (layered.bottom[node] as number));
    for (let node = 0; node < layered.size; node += 1) (layers[layered.rank[node] as number] as number[]).push(node);
    for (const layer of layers) layer.sort((left, right) => key(left) - key(right) || left - right);
    return layers;
  }
  // Pre-order from the roots keeps the descendants of a parent next to each other in every rank.
  const seen = new Uint8Array(layered.size);
  const stack: number[] = [];
  for (let root = layered.real - 1; root >= 0; root -= 1) {
    if (layered.rank[root] === 0) stack.push(root);
  }
  while (stack.length > 0) {
    const node = stack.pop() as number;
    if (seen[node]) continue;
    seen[node] = 1;
    (layers[layered.rank[node] as number] as number[]).push(node);
    const list = layered.down[node] as number[];
    for (let at = list.length - 1; at >= 0; at -= 1) stack.push(list[at] as number);
  }
  return layers;
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  const middle = values.length >> 1;
  return values.length % 2 === 1
    ? (values[middle] as number)
    : ((values[middle - 1] as number) + (values[middle] as number)) / 2;
}

/**
 * Sorts a rank by where each node's neighbours stand across the rank next to it, as a fraction of
 * that rank so ranks of different sizes compare. Nodes without a neighbour there keep their slot,
 * the others take the remaining slots in sorted order.
 */
function reorder(
  layer: readonly number[],
  neighbours: readonly (readonly number[])[],
  layers: readonly (readonly number[])[],
  layered: Layered,
  pos: Int32Array,
  metric: Metric,
): number[] {
  const keys = layer.map((node) => {
    const list = neighbours[node] as readonly number[];
    if (list.length === 0) return Number.NaN;
    const values = list.map(
      (other) => ((pos[other] as number) + 0.5) / (layers[layered.rank[other] as number] as number[]).length,
    );
    return metric === "mean" ? values.reduce((sum, value) => sum + value, 0) / values.length : median(values);
  });
  const movable = layer
    .map((node, slot) => ({ node, slot, key: keys[slot] as number }))
    .filter((entry) => !Number.isNaN(entry.key))
    .sort((left, right) => left.key - right.key || left.slot - right.slot);
  let next = 0;
  return layer.map((node, slot) =>
    Number.isNaN(keys[slot] as number) ? node : (movable[next++] as { node: number }).node,
  );
}

/** Crossings between neighbouring ranks, by counting inversions with a Fenwick tree. */
function orderCrossings(layers: readonly (readonly number[])[], layered: Layered, pos: Int32Array): number {
  let total = 0;
  for (let at = 0; at + 1 < layers.length; at += 1) {
    const lower = (layers[at + 1] as readonly number[]).length;
    const tree = new Int32Array(lower + 1);
    let inserted = 0;
    for (const node of layers[at] as readonly number[]) {
      const targets = (layered.down[node] as readonly number[])
        .map((child) => pos[child] as number)
        .sort((a, b) => a - b);
      for (const target of targets) {
        let below = 0;
        for (let walk = target + 1; walk > 0; walk -= walk & -walk) below += tree[walk] as number;
        total += inserted - below;
      }
      for (const target of targets) {
        for (let walk = target + 1; walk <= lower; walk += walk & -walk) tree[walk] = (tree[walk] as number) + 1;
        inserted += 1;
      }
    }
  }
  return total;
}

function crossingsBetween(left: number, right: number, layered: Layered, pos: Int32Array): number {
  let count = 0;
  for (const one of layered.up[left] as readonly number[]) {
    for (const other of layered.up[right] as readonly number[]) if ((pos[one] as number) > (pos[other] as number)) count += 1;
  }
  for (const one of layered.down[left] as readonly number[]) {
    for (const other of layered.down[right] as readonly number[]) if ((pos[one] as number) > (pos[other] as number)) count += 1;
  }
  return count;
}

/** Swaps neighbours in a rank while that removes crossings with the ranks around it. */
function transpose(layers: number[][], layered: Layered, pos: Int32Array): void {
  for (let pass = 0; pass < TRANSPOSE_PASSES; pass += 1) {
    let improved = false;
    for (const layer of layers) {
      for (let slot = 0; slot + 1 < layer.length; slot += 1) {
        const left = layer[slot] as number;
        const right = layer[slot + 1] as number;
        if (crossingsBetween(right, left, layered, pos) < crossingsBetween(left, right, layered, pos)) {
          layer[slot] = right;
          layer[slot + 1] = left;
          pos[right] = slot;
          pos[left] = slot + 1;
          improved = true;
        }
      }
    }
    if (!improved) return;
  }
}

function positionsOf(layers: readonly (readonly number[])[], size: number): Int32Array {
  const pos = new Int32Array(size);
  for (const layer of layers) layer.forEach((node, slot) => (pos[node] = slot));
  return pos;
}

/** Sweeps up and down the ranks, keeping the order with the fewest crossings. */
function orderLayers(
  layered: Layered,
  candidate: Candidate,
  rankCount: number,
): { layers: number[][]; crossings: number } {
  let layers = seedLayers(layered, candidate.seed, rankCount);
  const pos = positionsOf(layers, layered.size);
  transpose(layers, layered, pos);
  let best = layers.map((layer) => [...layer]);
  let fewest = orderCrossings(layers, layered, pos);
  let stalled = 0;
  const ranks = Array.from({ length: rankCount }, (_unused, at) => at);
  for (let sweep = 0; sweep < SWEEPS && fewest > 0 && stalled < STALL_LIMIT; sweep += 1) {
    const downward = sweep % 2 === 0;
    layers = layers.map((layer) => [...layer]);
    for (const at of downward ? ranks.slice(1) : ranks.slice(0, -1).reverse()) {
      const next = reorder(layers[at] as number[], downward ? layered.up : layered.down, layers, layered, pos, candidate.metric);
      layers[at] = next;
      next.forEach((node, slot) => (pos[node] = slot));
    }
    transpose(layers, layered, pos);
    const crossings = orderCrossings(layers, layered, pos);
    if (crossings < fewest) {
      fewest = crossings;
      best = layers.map((layer) => [...layer]);
      stalled = 0;
    } else {
      stalled += 1;
    }
  }
  return { layers: best, crossings: fewest };
}

/* ------------------------------------------------------------------------------------------ */
/* Coordinates across the ranks                                                                */
/* ------------------------------------------------------------------------------------------ */

type Placement = "relaxed" | "tidy";

/**
 * Closest positions to `want` that keep the order and the minimum gaps between neighbours: pool
 * adjacent violators on `want` minus the cumulative gap, which is isotonic regression.
 */
function project(want: readonly number[], gaps: readonly number[], weights: readonly number[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (let slot = 0; slot < want.length; slot += 1) {
    offsets.push(offset);
    offset += gaps[slot] ?? 0;
  }
  const sums: number[] = [];
  const masses: number[] = [];
  const counts: number[] = [];
  want.forEach((value, slot) => {
    const weight = weights[slot] as number;
    let sum = weight * (value - (offsets[slot] as number));
    let mass = weight;
    let count = 1;
    while (sums.length > 0 && (sums[sums.length - 1] as number) / (masses[masses.length - 1] as number) > sum / mass) {
      sum += sums.pop() as number;
      mass += masses.pop() as number;
      count += counts.pop() as number;
    }
    sums.push(sum);
    masses.push(mass);
    counts.push(count);
  });
  const out: number[] = [];
  sums.forEach((sum, block) => {
    for (let member = 0; member < (counts[block] as number); member += 1) {
      out.push(sum / (masses[block] as number) + (offsets[out.length] as number));
    }
  });
  return out;
}

/** The width the horizontal run of each long edge needs in its middle rank, from the positions in `x`. */
function reservation(layered: Layered, x: Float64Array): number[] {
  return Array.from({ length: layered.size }, (_unused, node) => {
    if (node < layered.real) return 0;
    const top = layered.top[node] as number;
    const bottom = layered.bottom[node] as number;
    return 2 * (layered.rank[node] as number) === (layered.rank[top] as number) + (layered.rank[bottom] as number)
      ? Math.abs((x[top] as number) - (x[bottom] as number))
      : 0;
  });
}

/**
 * Walker-style tidy pass on the spanning forest of the layers: every node belongs to the one
 * parent nearest to it across the rank, ranks are finished from the bottom up, a parent goes over
 * its children, and when its left neighbour leaves it no room it takes its descendants along.
 */
function centre(
  layered: Layered,
  layers: readonly (readonly number[])[],
  x: Float64Array,
  gapOf: (left: number, right: number) => number,
): void {
  const pos = positionsOf(layers, layered.size);
  const fraction = (node: number): number =>
    ((pos[node] as number) + 0.5) / (layers[layered.rank[node] as number] as number[]).length;
  const kids: number[][] = Array.from({ length: layered.size }, () => []);
  for (const row of layers) {
    for (const node of row) {
      const parents = layered.up[node] as readonly number[];
      if (parents.length === 0) continue;
      let owner = parents[0] as number;
      for (const parent of parents) {
        if (Math.abs(fraction(parent) - fraction(node)) < Math.abs(fraction(owner) - fraction(node)) - 1e-12) {
          owner = parent;
        }
      }
      (kids[owner] as number[]).push(node);
    }
  }
  /** Moves everything below `root`, and all that stands right of it in those ranks, by `by`. */
  const shiftBelow = (root: number, by: number): void => {
    let from = Math.min(...(kids[root] as number[]).map((kid) => pos[kid] as number));
    for (let at = (layered.rank[root] as number) + 1; at < layers.length && Number.isFinite(from); at += 1) {
      const row = layers[at] as readonly number[];
      let next = Number.POSITIVE_INFINITY;
      for (let slot = from; slot < row.length; slot += 1) {
        const node = row[slot] as number;
        x[node] = (x[node] as number) + by;
        for (const kid of kids[node] as number[]) next = Math.min(next, pos[kid] as number);
      }
      from = next;
    }
  };

  let wall = 0;
  for (let at = layers.length - 1; at >= 0; at -= 1) {
    const row = layers[at] as readonly number[];
    let previous = -1;
    for (const node of row) {
      const list = kids[node] as number[];
      const floor = previous < 0 ? Number.NEGATIVE_INFINITY : (x[previous] as number) + gapOf(previous, node);
      let placed: number;
      if (list.length > 0) {
        const wish = ((x[list[0] as number] as number) + (x[list[list.length - 1] as number] as number)) / 2;
        placed = Math.max(wish, floor);
        if (placed > wish) shiftBelow(node, placed - wish);
      } else {
        placed = previous < 0 ? wall : floor;
      }
      x[node] = placed;
      previous = node;
    }
    for (const node of row) wall = Math.min(wall, x[node] as number);
  }
}

/**
 * Places every rank by `placement`, then settles the stand-ins of long edges. `reserve` is the
 * width each stand-in keeps free in its rank; a warm `start` continues from earlier positions.
 *
 * "relaxed" is the rank-by-rank 1-D relaxation of the swimlane engine: every rank moves to where
 * its neighbours pull it and is projected back to legal, alternating up and down the ranks.
 * "tidy" puts every parent over its children exactly, as a tidy tree does.
 */
function place(
  layered: Layered,
  layers: readonly (readonly number[])[],
  placement: Placement,
  reserve: readonly number[],
  start: Float64Array | null,
): Float64Array {
  const x = start ? Float64Array.from(start) : new Float64Array(layered.size);

  const widthOf = (node: number): number => (node < layered.real ? (layered.cross[node] as number) : (reserve[node] as number));
  const gapOf = (left: number, right: number): number =>
    (widthOf(left) + widthOf(right)) / 2 + (left < layered.real && right < layered.real ? NODE_GAP : CHANNEL_GAP);
  const gaps = layers.map((row) => row.slice(1).map((node, slot) => gapOf(row[slot] as number, node)));
  const weights = layers.map((row) => row.map((node) => (node < layered.real ? 1 : CHANNEL_WEIGHT)));

  if (!start) {
    layers.forEach((row, at) => {
      const packed = project(row.map(() => 0), gaps[at] as number[], row.map(() => 1));
      const middle = ((packed[0] ?? 0) + (packed[packed.length - 1] ?? 0)) / 2;
      row.forEach((node, slot) => (x[node] = (packed[slot] as number) - middle));
    });
  }

  // A long edge is drawn down its parent's column, across at half height and down its child's
  // column, so its stand-ins hold those columns and the cards make room.
  const standIn = (node: number): number => {
    const top = layered.top[node] as number;
    const bottom = layered.bottom[node] as number;
    const twice = 2 * (layered.rank[node] as number);
    const middle = (layered.rank[top] as number) + (layered.rank[bottom] as number);
    if (twice < middle) return x[top] as number;
    if (twice > middle) return x[bottom] as number;
    return ((x[top] as number) + (x[bottom] as number)) / 2;
  };
  const relax = (at: number, side: "up" | "down"): void => {
    const row = layers[at] as readonly number[];
    const near = side === "up" ? layered.up : layered.down;
    const wants: number[] = [];
    const masses: number[] = [];
    row.forEach((node, slot) => {
      if (node >= layered.real) {
        wants.push(standIn(node));
        masses.push(CHANNEL_WEIGHT);
        return;
      }
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      let sum = 0;
      const list = near[node] as readonly number[];
      for (const other of list) {
        const at2 = other < layered.real ? (x[other] as number) : (x[side === "up" ? (layered.top[other] as number) : (layered.bottom[other] as number)] as number);
        low = Math.min(low, at2);
        high = Math.max(high, at2);
        sum += at2;
      }
      if (list.length === 0) {
        // Nothing pulls on it from this side, so it only fills the room the others leave.
        wants.push(x[node] as number);
        masses.push(EPSILON);
      } else {
        wants.push(side === "down" ? (low + high) / 2 : sum / list.length);
        masses.push((weights[at] as number[])[slot] as number);
      }
    });
    const moved = project(wants, gaps[at] as number[], masses);
    row.forEach((node, slot) => (x[node] = moved[slot] as number));
  };

  if (placement === "tidy") {
    centre(layered, layers, x, gapOf);
  } else {
    for (let round = 0; round < (start ? WARM_ROUNDS : ROUNDS); round += 1) {
      for (let at = 1; at < layers.length; at += 1) relax(at, "up");
      for (let at = layers.length - 2; at >= 0; at -= 1) relax(at, "down");
    }
  }

  // Settle the stand-ins on the final columns; the cards beside them slide away if they must.
  for (let at = 1; at < layers.length - 1; at += 1) {
    const row = layers[at] as readonly number[];
    if (row.every((node) => node < layered.real)) continue;
    const moved = project(
      row.map((node) => (node >= layered.real ? standIn(node) : (x[node] as number))),
      gaps[at] as number[],
      weights[at] as number[],
    );
    row.forEach((node, slot) => (x[node] = moved[slot] as number));
  }
  return x;
}

/* ------------------------------------------------------------------------------------------ */
/* One connected part                                                                          */
/* ------------------------------------------------------------------------------------------ */

interface Block {
  readonly members: readonly number[];
  /** Top-down rectangle of each member, from the origin. */
  readonly rects: readonly Rect[];
  /** Members per rank, in order across the rank. */
  readonly ranks: readonly (readonly number[])[];
  readonly width: number;
  readonly height: number;
}

function layoutBlock(graph: Graph, members: readonly number[]): Block {
  if (members.length === 1) {
    const [only] = members as readonly [number];
    const rect = { x: 0, y: 0, width: graph.cross[only] as number, height: graph.along[only] as number };
    return { members, rects: [rect], ranks: [[0]], width: rect.width, height: rect.height };
  }
  const local = new Map(members.map((node, position) => [node, position] as const));
  const links: Link[] = [];
  for (const [parent, child, label] of graph.links) {
    const from = local.get(parent);
    const to = local.get(child);
    if (from !== undefined && to !== undefined) links.push([from, to, label ?? 0]);
  }
  const cross = members.map((node) => graph.cross[node] as number);
  const along = members.map((node) => graph.along[node] as number);

  const { rank, forward } = rankEntities(members.length, links);
  const layered = expand(members.length, cross, rank, forward);
  const rankCount = rank.reduce((most, value) => Math.max(most, value), 0) + 1;

  const thickness = Array.from({ length: rankCount }, () => 0);
  members.forEach((_node, id) => {
    const at = rank[id] as number;
    thickness[at] = Math.max(thickness[at] as number, along[id] as number);
  });
  const tops: number[] = [];
  let cursor = 0;
  for (const value of thickness) {
    tops.push(cursor);
    cursor += value + RANK_GAP;
  }

  interface Drawing {
    readonly rects: Rect[];
    readonly layers: number[][];
    readonly score: ArrangementScore;
    readonly placement: Placement;
    readonly reserve: readonly number[];
  }
  const kept: { best: Drawing | null } = { best: null };
  const consider = (
    layers: number[][],
    x: Float64Array,
    placement: Placement,
    reserve: readonly number[],
  ): ArrangementScore => {
    let left = Number.POSITIVE_INFINITY;
    for (let id = 0; id < layered.real; id += 1) left = Math.min(left, (x[id] as number) - (cross[id] as number) / 2);
    const rects = members.map((_node, id) => ({
      x: (x[id] as number) - (cross[id] as number) / 2 - left,
      y: tops[rank[id] as number] as number,
      width: cross[id] as number,
      height: along[id] as number,
    }));
    const score = scoreRoutes(rects, links, graph.flat);
    if (!kept.best || compareScores(score, kept.best.score) < 0) kept.best = { rects, layers, score, placement, reserve };
    return score;
  };

  // The candidate orders are compared on the relaxed placement; the best one is then tried with
  // the other placement and with room kept free for the horizontal runs of long edges.
  const none = reservation(layered, new Float64Array(layered.size));
  const seen = new Set<string>();
  let leader: { layers: number[][]; x: Float64Array; score: ArrangementScore } | null = null;
  for (const candidate of CANDIDATES) {
    const { layers } = orderLayers(layered, candidate, rankCount);
    const signature = layers.map((layer) => layer.join(",")).join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const x = place(layered, layers, "relaxed", none, null);
    const score = consider(layers, x, "relaxed", none);
    if (!leader || compareScores(score, leader.score) < 0) leader = { layers, x, score };
  }
  const { layers, x: relaxed, score: relaxedScore } = leader as NonNullable<typeof leader>;
  for (const placement of ["relaxed", "tidy"] as const) {
    const first = placement === "relaxed" ? relaxed : place(layered, layers, placement, none, null);
    const score = placement === "relaxed" ? relaxedScore : consider(layers, first, placement, none);
    if (score.throughCards === 0) continue;
    const reserve = reservation(layered, first);
    if (reserve.some((width) => width > 0)) {
      consider(layers, place(layered, layers, placement, reserve, placement === "relaxed" ? first : null), placement, reserve);
    }
  }

  // Local search on the drawing: a card that routes pass through tries the other places in its rank.
  let trials = Math.floor(UNBLOCK_WORK / (members.length + links.length));
  for (let improved = true; improved && trials > 0 && (kept.best as Drawing).score.throughCards > 0; ) {
    improved = false;
    const current = kept.best as Drawing;
    const hit = new Set<number>();
    scoreRoutes(current.rects, links, graph.flat, hit);
    for (const card of [...hit].sort((a, b) => a - b)) {
      const row = current.layers[rank[card] as number] as number[];
      const from = row.indexOf(card);
      for (let to = 0; to < row.length && !improved && trials > 0; to += 1) {
        if (to === from) continue;
        trials -= 1;
        const moved = current.layers.map((layer) => [...layer]);
        const target = moved[rank[card] as number] as number[];
        target.splice(from, 1);
        target.splice(to, 0, card);
        consider(moved, place(layered, moved, current.placement, current.reserve, null), current.placement, current.reserve);
        improved = kept.best !== current;
      }
      if (improved) break;
    }
  }

  const chosen = kept.best as Drawing;
  let width = 0;
  let height = 0;
  for (const rect of chosen.rects) {
    width = Math.max(width, rect.x + rect.width);
    height = Math.max(height, rect.y + rect.height);
  }
  return {
    members,
    rects: chosen.rects,
    ranks: chosen.layers.map((layer) => layer.filter((id) => id < layered.real)),
    width,
    height,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Direction and shelves                                                                       */
/* ------------------------------------------------------------------------------------------ */

function orient(rect: Rect, direction: ArrangeDirection, total: { width: number; height: number }): Rect {
  if (direction === "tb") return rect;
  if (direction === "bt") return { ...rect, y: total.height - rect.y - rect.height };
  if (direction === "lr") return { x: rect.y, y: rect.x, width: rect.height, height: rect.width };
  return { x: total.height - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
}

/** Eighths of a pixel are exact in binary, so what the screen computes from them has no rounding noise. */
function snap(value: number): number {
  return Math.round(value * 8) / 8;
}

/** Zoom that fits a box on a 16:9 screen; larger reads better. */
function fit(width: number, height: number): number {
  return Math.min(VIEW.width / Math.max(width, 1), VIEW.height / Math.max(height, 1));
}

/**
 * Lays the parts out left to right on shelves, the largest first. A part opens a new shelf below
 * when that fits a 16:9 screen better than going beside the previous one.
 */
function shelve(sizes: readonly { readonly width: number; readonly height: number }[]): Point[] {
  const origins: Point[] = [];
  let totalWidth = 0;
  let totalHeight = 0;
  let shelfTop = 0;
  let cursor = 0;
  for (const size of sizes) {
    if (origins.length === 0) {
      origins.push({ x: 0, y: 0 });
      totalWidth = size.width;
      totalHeight = size.height;
      cursor = size.width;
      continue;
    }
    const besideX = cursor + NODE_GAP;
    const besideWidth = Math.max(totalWidth, besideX + size.width);
    const besideHeight = Math.max(totalHeight, shelfTop + size.height);
    const belowTop = totalHeight + RANK_GAP;
    const belowWidth = Math.max(totalWidth, size.width);
    const belowHeight = belowTop + size.height;
    if (fit(belowWidth, belowHeight) > fit(besideWidth, besideHeight)) {
      origins.push({ x: 0, y: belowTop });
      shelfTop = belowTop;
      cursor = size.width;
      totalWidth = belowWidth;
      totalHeight = belowHeight;
    } else {
      origins.push({ x: besideX, y: shelfTop });
      cursor = besideX + size.width;
      totalWidth = besideWidth;
      totalHeight = besideHeight;
    }
  }
  return origins;
}

/**
 * Arranges the entities in ranks by longest path from the roots, orders each rank for few
 * crossings, and places parents over their children, so connections stay short. Computed once in
 * top-down space and turned for the other directions; unconnected parts are shelved beside or
 * below the largest one. Deterministic: the result does not depend on the order of the input.
 */
export function arrange(
  nodes: readonly ArrangeNode[],
  edges: readonly ArrangeEdge[],
  direction: ArrangeDirection,
): Arrangement {
  const graph = buildGraph(nodes, edges, direction);
  const blocks = partsOf(graph).map((members) => layoutBlock(graph, members));
  const oriented = blocks.map((block) => ({
    block,
    box: orient({ x: 0, y: 0, width: block.width, height: block.height }, direction, block),
  }));
  const origins = shelve(oriented.map((item) => item.box));

  const sizes = new Map<string, NodeSize>();
  const positions = new Map<string, Point>();
  const ranks: string[][] = [];
  oriented.forEach(({ block }, part) => {
    const origin = origins[part] as Point;
    block.members.forEach((node, slot) => {
      const rect = orient(block.rects[slot] as Rect, direction, block);
      const name = graph.names[node] as string;
      positions.set(name, { x: snap(MARGIN + origin.x + rect.x), y: snap(MARGIN + origin.y + rect.y) });
      sizes.set(name, { width: rect.width, height: rect.height });
    });
    block.ranks.forEach((row, at) => {
      const names = row.map((id) => graph.names[block.members[id] as number] as string);
      if (ranks[at]) (ranks[at] as string[]).push(...names);
      else ranks[at] = names;
    });
  });

  let width = 0;
  let height = 0;
  for (const [name, point] of positions) {
    const size = sizes.get(name) as NodeSize;
    width = Math.max(width, point.x + size.width);
    height = Math.max(height, point.y + size.height);
  }
  return { positions, width, height, ranks };
}
