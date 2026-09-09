import type { Point } from "./layout";

export interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

export type Side = "top" | "right" | "bottom" | "left";
export type LayoutFlow = "tb" | "bt" | "lr" | "rl" | "free";
export type ConnectionPolicy = "with-layout" | "free" | "lr" | "rl" | "tb" | "bt";
export type EdgeStyle = "rounded" | "right-angle" | "smooth";

export const CONNECTION_POLICY_CHOICES: readonly {
  readonly id: ConnectionPolicy;
  readonly label: string;
}[] = [
  { id: "with-layout", label: "With layout" },
  { id: "free", label: "Free" },
  { id: "lr", label: "Left to right" },
  { id: "rl", label: "Right to left" },
  { id: "tb", label: "Top to bottom" },
  { id: "bt", label: "Bottom to top" },
];

export const EDGE_STYLE_CHOICES: readonly { readonly id: EdgeStyle; readonly label: string }[] = [
  { id: "rounded", label: "Rounded orthogonal" },
  { id: "right-angle", label: "Right-angle" },
  { id: "smooth", label: "Smooth curves" },
];

export interface Route {
  readonly sourceSide: Side;
  readonly targetSide: Side;
  /** Corridor between the two cards, in flow coordinates. The endpoints are not included. */
  readonly waypoints: readonly Point[];
  /** False when no candidate corridor cleared every obstacle, so a caller can surface the miss. */
  readonly clear: boolean;
}

/** How far a path leaves a card before it may turn. */
export const STUB = 30;
/** How far a corridor stays off a card it passes, and how far obstacles are grown before testing. */
export const CLEARANCE = 20;
/**
 * How many cards nearest the pair contribute a lane to the fallback search. Every card is still
 * tested for hits; this only bounds how many suggest a detour coordinate, and so bounds the grid at
 * `(2 * GRID_LANES + 2)` coordinates per axis.
 * ponytail: nearest-K by distance to the endpoint box, not a cost-ranked visibility graph. Raise it
 * only if a real model needs a detour around a card further out than the fourteen nearest.
 */
export const GRID_LANES = 14;
/** Smallest distance an attachment point keeps from a card corner. */
const CORNER_PAD = 18;
/** Distance between two paths that would otherwise share an attachment point. */
export const LANE_STEP = 16;
/** CSS-pixel readability limits at the canvas's minimum fitted zoom. */
export const ROUTE_REFERENCE_ZOOM = 0.5;
export const SHARED_DISTANCE = LANE_STEP / 8;
export const SHARED_CLEARANCE = CLEARANCE + LANE_STEP / 2;
export const SHARED_RUN_TOLERANCE = (LANE_STEP * 3) / 8;

function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function isVertical(side: Side): boolean {
  return side === "top" || side === "bottom";
}

/** Separation between two spans on one axis. Negative when the spans overlap. */
function separation(aMin: number, aSize: number, bMin: number, bSize: number): number {
  return Math.max(bMin - (aMin + aSize), aMin - (bMin + bSize));
}

/**
 * The boundary each end faces, decided from the two rectangles rather than their centres. A pair
 * whose x extents overlap while the cards sit apart vertically faces bottom/top even when the
 * centre delta leans horizontal, because leaving through a side the other card does not lie beyond
 * forces the path straight back over its own card. Ties, which include perfectly stacked cards,
 * resolve to the vertical axis, so a near-collinear pair cannot flip between two sides.
 */
export function pickSides(source: Rect, target: Rect): {
  readonly sourceSide: Side;
  readonly targetSide: Side;
} {
  const from = centreOf(source);
  const to = centreOf(target);

  if (
    separation(source.x, source.width, target.x, target.width) >
    separation(source.y, source.height, target.y, target.height)
  ) {
    return to.x >= from.x
      ? { sourceSide: "right", targetSide: "left" }
      : { sourceSide: "left", targetSide: "right" };
  }
  return to.y >= from.y
    ? { sourceSide: "bottom", targetSide: "top" }
    : { sourceSide: "top", targetSide: "bottom" };
}

function flowSides(flow: Exclude<LayoutFlow, "free">): {
  readonly sourceSide: Side;
  readonly targetSide: Side;
} {
  if (flow === "lr") return { sourceSide: "right", targetSide: "left" };
  if (flow === "rl") return { sourceSide: "left", targetSide: "right" };
  if (flow === "bt") return { sourceSide: "top", targetSide: "bottom" };
  return { sourceSide: "bottom", targetSide: "top" };
}

export function sidesFor(
  policy: ConnectionPolicy,
  flow: LayoutFlow,
  source: Rect,
  target: Rect,
): {
  readonly sourceSide: Side;
  readonly targetSide: Side;
} {
  if (policy === "free") return pickSides(source, target);
  if (policy === "with-layout") return flow === "free" ? pickSides(source, target) : flowSides(flow);
  return flowSides(policy);
}

/**
 * The point on `side` where a path attaches, slid along the boundary by `lane` to separate paths.
 * `laneCount` is how many lanes share this boundary: when they would not fit at the full `LANE_STEP`,
 * the spacing compresses so the outermost still lands inside the corner pad instead of every lane
 * clamping onto the same point and merging the paths that leave there.
 */
export function attachmentPoint(rect: Rect, side: Side, lane = 0, laneCount = 0): Point {
  const centre = centreOf(rect);
  const span = isVertical(side) ? rect.width : rect.height;
  const limit = Math.max(0, span / 2 - CORNER_PAD);
  const extreme = (laneCount - 1) / 2;
  const spacing = extreme > 0 ? Math.min(LANE_STEP, limit / extreme) : LANE_STEP;
  const slide = Math.max(-limit, Math.min(limit, lane * spacing));

  if (side === "top") return { x: centre.x + slide, y: rect.y };
  if (side === "bottom") return { x: centre.x + slide, y: rect.y + rect.height };
  if (side === "left") return { x: rect.x, y: centre.y + slide };
  return { x: rect.x + rect.width, y: centre.y + slide };
}

function step(point: Point, side: Side, distance: number): Point {
  if (side === "top") return { x: point.x, y: point.y - distance };
  if (side === "bottom") return { x: point.x, y: point.y + distance };
  if (side === "left") return { x: point.x - distance, y: point.y };
  return { x: point.x + distance, y: point.y };
}

/** How far a ray from `at` along `side` runs before it enters `rect`. Infinite when it misses. */
function reach(at: Point, side: Side, rect: Rect): number {
  if (isVertical(side)) {
    if (at.x <= rect.x || at.x >= rect.x + rect.width) return Number.POSITIVE_INFINITY;
    return side === "top" ? at.y - (rect.y + rect.height) : rect.y - at.y;
  }
  if (at.y <= rect.y || at.y >= rect.y + rect.height) return Number.POSITIVE_INFINITY;
  return side === "left" ? at.x - (rect.x + rect.width) : rect.x - at.x;
}

/**
 * How far this end leaves its own card before the corridor may turn. The full stub is used unless a
 * card sits closer than that straight ahead, in which case the gap is shared, so a stub never lands
 * inside another card and leaves the corridor starting somewhere no route can begin. The partner
 * counts whatever direction it lies in; any other card counts only when the ray would actually run
 * into it.
 */
function stubOut(
  from: Point,
  side: Side,
  partner: Rect,
  others: readonly Rect[],
  extra = 0,
): Point {
  const partnerRoom =
    side === "top"
      ? from.y - (partner.y + partner.height)
      : side === "bottom"
        ? partner.y - from.y
        : side === "left"
          ? from.x - (partner.x + partner.width)
          : partner.x - from.x;

  let room = partnerRoom >= 0 ? partnerRoom : Number.POSITIVE_INFINITY;
  for (const rect of others) {
    const ahead = reach(from, side, rect);
    if (ahead >= 0 && ahead < room) room = ahead;
  }
  const cap = Number.isFinite(room) ? room / 2 : Number.POSITIVE_INFINITY;
  return step(from, side, Math.min(STUB + extra, cap));
}

function grow(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  };
}

/** Every candidate segment is axis aligned, so an overlap test on the two boxes is exact. */
function hits(from: Point, to: Point, rect: Rect): boolean {
  return (
    Math.min(from.x, to.x) < rect.x + rect.width &&
    Math.max(from.x, to.x) > rect.x &&
    Math.min(from.y, to.y) < rect.y + rect.height &&
    Math.max(from.y, to.y) > rect.y
  );
}

function hitCount(points: readonly Point[], blockers: readonly Rect[]): number {
  let count = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1] as Point;
    const to = points[index] as Point;
    for (const blocker of blockers) if (hits(from, to, blocker)) count += 1;
  }
  return count;
}

function corridors(
  from: Point,
  to: Point,
  blockers: readonly Rect[],
  verticalFirst: boolean,
  detour = 0,
  middleOffset = 0,
): Point[][] {
  // The midpoint corridor is offset on both axes, matching `gridRoute`, so the coordination pass can
  // shift a midpoint leg whichever way it runs. Without this a midpoint leg on the axis that was not
  // offset stayed pinned and two edges kept merging on it.
  const xs = [(from.x + to.x) / 2 + middleOffset];
  const ys = [(from.y + to.y) / 2 + middleOffset];
  for (const blocker of blockers) {
    xs.push(blocker.x - CLEARANCE - detour, blocker.x + blocker.width + CLEARANCE + detour);
    ys.push(blocker.y - CLEARANCE - detour, blocker.y + blocker.height + CLEARANCE + detour);
  }

  const throughY = ys.map((y) => [from, { x: from.x, y }, { x: to.x, y }, to]);
  const throughX = xs.map((x) => [from, { x, y: from.y }, { x, y: to.y }, to]);
  const elbowV = [from, { x: from.x, y: to.y }, to];
  const elbowH = [from, { x: to.x, y: from.y }, to];

  return verticalFirst
    ? [...throughY, elbowV, ...throughX, elbowH]
    : [...throughX, elbowH, ...throughY, elbowV];
}

/** Gap between a card and the box spanned by the two ends. Zero once they overlap. */
function gapToBox(rect: Rect, box: Rect): number {
  return Math.max(
    rect.x - (box.x + box.width),
    box.x - (rect.x + rect.width),
    rect.y - (box.y + box.height),
    box.y - (rect.y + rect.height),
    0,
  );
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * The fewest-segment orthogonal route from `from` to `to`, searched over the lanes the nearest
 * cards suggest. Every shape in `corridors` turns on a single free coordinate, so a card that
 * straddles both legs of that turn leaves them nothing to pick and a dense layout has no candidate
 * at all. This searches the whole lane grid instead, which contains those shapes and every longer
 * detour the same lanes can build.
 *
 * Bounded by construction: at most `GRID_LANES` cards contribute lanes, so the grid never exceeds
 * `(2 * GRID_LANES + 2)` coordinates per axis, its two clearance tables are filled once, and the
 * breadth-first sweep visits each cell once. Each move runs straight to any lane it can reach, so
 * one breadth layer is one bend and the first path found has the fewest segments. Returns `null`
 * when no route exists on that grid, so the caller reports an honest miss instead of a guess.
 */
function gridRoute(
  from: Point,
  to: Point,
  blockers: readonly Rect[],
  detour = 0,
  middleOffset = 0,
): Point[] | null {
  if (from.x === to.x && from.y === to.y) return [from];

  const box = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
  const lanes = [...blockers]
    .sort(
      (left, right) =>
        gapToBox(left, box) - gapToBox(right, box) || left.x - right.x || left.y - right.y,
    )
    .slice(0, GRID_LANES);

  const xs = sortedUnique([
    from.x,
    to.x,
    (from.x + to.x) / 2 + middleOffset,
    ...lanes.flatMap((rect) => [rect.x - CLEARANCE - detour, rect.x + rect.width + CLEARANCE + detour]),
  ]);
  const ys = sortedUnique([
    from.y,
    to.y,
    (from.y + to.y) / 2 + middleOffset,
    ...lanes.flatMap((rect) => [rect.y - CLEARANCE - detour, rect.y + rect.height + CLEARANCE + detour]),
  ]);
  const wide = xs.length;
  const high = ys.length;

  const openX = new Uint8Array((wide - 1) * high);
  for (let row = 0; row < high; row += 1) {
    for (let col = 0; col + 1 < wide; col += 1) {
      const left = { x: xs[col] as number, y: ys[row] as number };
      const right = { x: xs[col + 1] as number, y: ys[row] as number };
      openX[row * (wide - 1) + col] = blockers.some((rect) => hits(left, right, rect)) ? 0 : 1;
    }
  }
  const openY = new Uint8Array(wide * (high - 1));
  for (let col = 0; col < wide; col += 1) {
    for (let row = 0; row + 1 < high; row += 1) {
      const top = { x: xs[col] as number, y: ys[row] as number };
      const bottom = { x: xs[col] as number, y: ys[row + 1] as number };
      openY[col * (high - 1) + row] = blockers.some((rect) => hits(top, bottom, rect)) ? 0 : 1;
    }
  }

  const start = xs.indexOf(from.x) + ys.indexOf(from.y) * wide;
  const goal = xs.indexOf(to.x) + ys.indexOf(to.y) * wide;
  const came = new Int32Array(wide * high).fill(-1);
  came[start] = start;

  let frontier = [start];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const cell of frontier) {
      const col = cell % wide;
      const row = (cell - col) / wide;
      for (const [stepX, stepY] of STEPS) {
        for (let at = 1; ; at += 1) {
          const nextCol = col + stepX * at;
          const nextRow = row + stepY * at;
          if (nextCol < 0 || nextCol >= wide || nextRow < 0 || nextRow >= high) break;
          const open =
            stepX === 0
              ? openY[col * (high - 1) + Math.min(nextRow, nextRow - stepY)]
              : openX[row * (wide - 1) + Math.min(nextCol, nextCol - stepX)];
          if (!open) break;
          const reached = nextCol + nextRow * wide;
          if (came[reached] !== -1) continue;
          came[reached] = cell;
          if (reached === goal) {
            const path: Point[] = [];
            for (let walk = goal; ; walk = came[walk] as number) {
              const at2 = walk % wide;
              path.push({ x: xs[at2] as number, y: ys[(walk - at2) / wide] as number });
              if (walk === start) break;
            }
            return path.reverse();
          }
          next.push(reached);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The corridor between two cards, avoiding every other card and both endpoint cards. Fixed corridor
 * shapes are tried first and the first one that clears every obstacle wins; when none fits, a
 * bounded search over the lanes the nearest cards suggest looks for a longer detour. Both are
 * deterministic, so the same input always draws the same path. `clear` reports whether such a
 * corridor was found, so a graph the router cannot serve says so instead of quietly painting a line
 * through a card.
 */
export function routeEdge(
  source: Rect,
  target: Rect,
  obstacles: readonly Rect[],
  lane = 0,
  options: {
    readonly sourceSide?: Side;
    readonly targetSide?: Side;
    readonly sourceLane?: number;
    readonly targetLane?: number;
    readonly sourceLaneCount?: number;
    readonly targetLaneCount?: number;
    readonly detourLane?: number;
    readonly stubLane?: number;
    readonly verticalFirst?: boolean;
  } = {},
): Route {
  const picked = pickSides(source, target);
  const sourceSide = options.sourceSide ?? picked.sourceSide;
  const targetSide = options.targetSide ?? picked.targetSide;
  const from = attachmentPoint(source, sourceSide, options.sourceLane ?? lane, options.sourceLaneCount ?? 0);
  const to = attachmentPoint(target, targetSide, options.targetLane ?? lane, options.targetLaneCount ?? 0);
  // Shortening matters too: opposite-facing endpoints can both hit the same gap cap, so making
  // their stubs longer cannot separate them. Every candidate still leaves its card outward.
  const stubExtra = Math.max(LANE_STEP / 2 - STUB, (options.stubLane ?? 0) * LANE_STEP);
  const start = stubOut(from, sourceSide, target, obstacles, stubExtra);
  const end = stubOut(to, targetSide, source, obstacles, stubExtra);
  const detourLane = options.detourLane ?? lane;
  const detour = Math.abs(detourLane) * LANE_STEP;
  const middleOffset = detourLane * LANE_STEP;
  // Which leg turns first. Naturally the axis the source side faces, but the coordination pass may
  // flip it so an edge leaves a crowded boundary across the shared lane at once and runs its long
  // leg at an offset level, instead of pinning that leg to the shared attachment coordinate.
  const verticalFirst = options.verticalFirst ?? isVertical(sourceSide);

  // Only the cards near the straight line between the ends suggest a detour lane, but every card is
  // tested, so a detour cannot escape one obstacle by crossing another.
  const between = (blockers: readonly Rect[]): Rect[] =>
    blockers.filter((rect) =>
      hits(
        { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) },
        { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y) },
        rect,
      ),
    );

  let best: Point[] = [start, end];
  let bestHits = Number.POSITIVE_INFINITY;
  // The first pass keeps a roomy lane off every card. The second only demands that the path stay
  // out of the cards themselves, so a tight graph still gets a real non-crossing route rather than
  // being reported as unroutable. The two endpoint cards are never grown, because the stubs start on
  // their boundary, but they are always tested: a corridor that doubles back over its own source or
  // target is as wrong as one that cuts a stranger's card.
  for (const margin of [CLEARANCE, 0]) {
    const blockers = [...obstacles.map((rect) => grow(rect, margin)), source, target];
    bestHits = Number.POSITIVE_INFINITY;
    for (const corridor of corridors(
      start,
      end,
      between(blockers),
      verticalFirst,
      detour,
      middleOffset,
    )) {
      const count = hitCount([from, ...corridor, to], blockers);
      if (count === 0) return { sourceSide, targetSide, waypoints: corridor, clear: true };
      if (count < bestHits) {
        bestHits = count;
        best = corridor;
      }
    }
    // No fixed shape fitted, so search the lane grid for a longer detour. The result is re-tested
    // with the stubs attached, because the search only knows the corridor between them.
    const searched = gridRoute(start, end, blockers, detour, middleOffset);
    const searchedHits = searched ? hitCount([from, ...searched, to], blockers) : Number.POSITIVE_INFINITY;
    if (searched && searchedHits === 0) {
      return { sourceSide, targetSide, waypoints: searched, clear: true };
    }
    if (searched && searchedHits < bestHits) {
      bestHits = searchedHits;
      best = searched;
    }
  }

  return { sourceSide, targetSide, waypoints: best, clear: false };
}

export interface RouteEdgeRequest {
  readonly source: Rect;
  readonly target: Rect;
  readonly obstacles: readonly Rect[];
  readonly lane?: number;
  readonly options?: {
    readonly sourceSide?: Side;
    readonly targetSide?: Side;
    readonly sourceLane?: number;
    readonly targetLane?: number;
    readonly sourceLaneCount?: number;
    readonly targetLaneCount?: number;
    readonly detourLane?: number;
    readonly stubLane?: number;
    readonly verticalFirst?: boolean;
  };
}

function routePath(request: RouteEdgeRequest, route: Route): Point[] {
  return simplify([
    attachmentPoint(
      request.source,
      route.sourceSide,
      request.options?.sourceLane ?? request.lane ?? 0,
      request.options?.sourceLaneCount ?? 0,
    ),
    ...route.waypoints,
    attachmentPoint(
      request.target,
      route.targetSide,
      request.options?.targetLane ?? request.lane ?? 0,
      request.options?.targetLaneCount ?? 0,
    ),
  ]);
}

export function sharedRun(
  left: readonly Point[],
  right: readonly Point[],
  cards: readonly Rect[],
  zoom = ROUTE_REFERENCE_ZOOM,
): number {
  const tolerance = SHARED_DISTANCE / zoom;
  const margin = SHARED_CLEARANCE / zoom;
  let longest = 0;
  for (let leftIndex = 1; leftIndex < left.length; leftIndex += 1) {
    const leftA = left[leftIndex - 1] as Point;
    const leftB = left[leftIndex] as Point;
    for (let rightIndex = 1; rightIndex < right.length; rightIndex += 1) {
      const rightA = right[rightIndex - 1] as Point;
      const rightB = right[rightIndex] as Point;
      const vertical = leftA.x === leftB.x && rightA.x === rightB.x;
      const horizontal = leftA.y === leftB.y && rightA.y === rightB.y;
      if (!vertical && !horizontal) continue;
      const along = vertical ? "y" : "x";
      const across = vertical ? "x" : "y";
      if (Math.abs(leftA[across] - rightA[across]) > tolerance) continue;
      const start = Math.max(Math.min(leftA[along], leftB[along]), Math.min(rightA[along], rightB[along]));
      const end = Math.min(Math.max(leftA[along], leftB[along]), Math.max(rightA[along], rightB[along]));
      if (end <= start) continue;
      const intervals: [number, number][] = [];
      for (const card of cards) {
        const width = vertical ? card.width : card.height;
        if (Math.min(leftA[across], rightA[across]) > card[across] + width + margin ||
            Math.max(leftA[across], rightA[across]) < card[across] - margin) continue;
        const low = Math.max(start, card[along] - margin);
        const high = Math.min(end, card[along] + (vertical ? card.height : card.width) + margin);
        if (high > low) intervals.push([low, high]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (const interval of intervals) {
        if (interval[0] > high) {
          low = interval[0];
          high = interval[1];
        } else {
          high = Math.max(high, interval[1]);
        }
        longest = Math.max(longest, high - low);
      }
    }
  }
  return longest * zoom;
}

/** Detour-lane offsets tried when separating a shared corridor, smallest first for stable output. */
const DETOUR_DELTAS: readonly number[] = [0.5, -0.5, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];

/**
 * The near-card shared-run penalty. `energy` is the sum of squared over-tolerance runs, so trading
 * one long junction for two shorter ones is progress even when the pair count does not drop, which
 * lets the search cross the swap plateaus a plain worst-or-count objective gets stuck on.
 */
interface SharedCost {
  readonly energy: number;
  readonly pairs: readonly { readonly left: number; readonly right: number }[];
}

function costFromRuns(runs: readonly (readonly number[])[]): SharedCost {
  const pairs: { readonly left: number; readonly right: number; readonly run: number }[] = [];
  let energy = 0;
  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      const run = (runs[left] as readonly number[])[right] as number;
      if (run > SHARED_RUN_TOLERANCE) {
        pairs.push({ left, right, run });
        energy += run * run;
      }
    }
  }
  pairs.sort((a, b) => b.run - a.run || a.left - b.left || a.right - b.right);
  return { energy, pairs: pairs.map(({ left, right }) => ({ left, right })) };
}

/**
 * Routes a set of edges together, then coordinates their corridors: `routeEdge` still owns
 * obstacle-aware routing per edge, but a per-edge detour derived from its own attachment lanes
 * cannot see that two edges picked the same mid-route clearance line or stubbed out to the same
 * level beside a shared card, so a false junction forms. This pass re-lanes one edge at a time on
 * either lever, the perpendicular detour or the outward stub distance, keeping only clear reroutes
 * that strictly lower the shared-run cost, until no distinct-edge pair shares more than a single
 * point beside a card or no clear move helps. Deterministic: fixed candidate order and lexicographic
 * tie-breaks.
 */
export function routeEdges(requests: readonly RouteEdgeRequest[]): Route[] {
  const candidates = requests.map(() => new Map<string, Route>());
  const reroute = (index: number, detour: number, stub: number, verticalFirst?: boolean): Route => {
    const request = requests[index] as RouteEdgeRequest;
    const key = `${detour},${stub},${verticalFirst}`;
    const cached = candidates[index]?.get(key);
    if (cached) return cached;
    const route = routeEdge(request.source, request.target, request.obstacles, request.lane ?? 0, {
      ...request.options,
      detourLane: detour,
      stubLane: stub,
      ...(verticalFirst === undefined ? {} : { verticalFirst }),
    });
    candidates[index]?.set(key, route);
    return route;
  };

  const size = requests.length;
  const detours = requests.map((request) => request.options?.detourLane ?? request.lane ?? 0);
  const stubs = requests.map((request) => request.options?.stubLane ?? 0);
  const flips = requests.map((request) => request.options?.verticalFirst) as (boolean | undefined)[];
  const routes = requests.map((_request, index) =>
    reroute(index, detours[index] as number, stubs[index] as number, flips[index]),
  );
  const paths = routes.map((route, index) => routePath(requests[index] as RouteEdgeRequest, route));
  const cards = [...new Set(requests.flatMap((request) => [request.source, request.target, ...request.obstacles]))];

  const runsAgainst = (index: number, path: readonly Point[]): number[] => {
    const row = new Array<number>(size).fill(0);
    for (let other = 0; other < size; other += 1) {
      if (other === index) continue;
      row[other] = sharedRun(path, paths[other] as readonly Point[], cards);
    }
    return row;
  };

  const runs = paths.map((path, index) => runsAgainst(index, path));

  // A shortened stub only frees its lane when the corridor turns there, so offer both turn orders.
  const naturalFirst = (index: number): boolean => {
    const side = (routes[index] as Route).sourceSide;
    return side === "top" || side === "bottom";
  };
  const moves = (
    detour: number,
    stub: number,
    flip: boolean | undefined,
    natural: boolean,
  ): readonly { readonly detour: number; readonly stub: number; readonly flip: boolean | undefined }[] => {
    const out: { readonly detour: number; readonly stub: number; readonly flip: boolean | undefined }[] = [];
    for (const delta of DETOUR_DELTAS) out.push({ detour: detour + delta, stub, flip });
    for (const delta of DETOUR_DELTAS) {
      const nextStub = Math.max((LANE_STEP / 2 - STUB) / LANE_STEP, stub + delta);
      out.push({ detour, stub: nextStub, flip });
      out.push({ detour, stub: nextStub, flip: !(flip ?? natural) });
    }
    out.push({ detour, stub, flip: !(flip ?? natural) });
    return out;
  };

  let cost = costFromRuns(runs);

  // Descent over the offending pairs: a merged corridor is usually freed by re-laning one of the two
  // edges that share it. Each attempt applies the move that lowers the shared-run energy the most;
  // energy strictly decreases over finitely many lane states, so the search terminates, and the
  // attempt cap bounds it regardless.
  const energyOf = (run: number): number => run > SHARED_RUN_TOLERANCE ? run * run : 0;
  for (let attempt = 0; attempt < size * size && cost.pairs.length > 0; attempt += 1) {
    let best:
      | {
          readonly index: number;
          readonly detour: number;
          readonly stub: number;
          readonly flip: boolean | undefined;
          readonly route: Route;
          readonly energy: number;
        }
      | null = null;
    const touched = new Set<number>();
    for (const pair of cost.pairs) {
      touched.add(pair.left);
      touched.add(pair.right);
    }
    for (const index of touched) {
      const current = flips[index];
      const seen = new Set([JSON.stringify(paths[index])]);
      for (const move of moves(detours[index] as number, stubs[index] as number, current, naturalFirst(index))) {
        if (move.detour === detours[index] && move.stub === stubs[index] && move.flip === current) continue;
        const route = reroute(index, move.detour, move.stub, move.flip);
        if (!route.clear) continue;
        const path = routePath(requests[index] as RouteEdgeRequest, route);
        const key = JSON.stringify(path);
        if (seen.has(key)) continue;
        seen.add(key);
        const row = runsAgainst(index, path);
        const energy = row.reduce((sum, run, other) =>
          sum + energyOf(run) - energyOf((runs[index] as number[])[other] as number), cost.energy);
        if (energy < cost.energy && (!best || energy < best.energy)) {
          best = { index, detour: move.detour, stub: move.stub, flip: move.flip, route, energy };
        }
      }
    }
    if (!best) break;
    detours[best.index] = best.detour;
    stubs[best.index] = best.stub;
    flips[best.index] = best.flip;
    routes[best.index] = best.route;
    paths[best.index] = routePath(requests[best.index] as RouteEdgeRequest, best.route);
    const row = runsAgainst(best.index, paths[best.index] as readonly Point[]);
    runs[best.index] = row;
    for (let other = 0; other < size; other += 1) {
      if (other === best.index) continue;
      (runs[other] as number[])[best.index] = row[other] as number;
    }
    cost = costFromRuns(runs);
  }

  return routes;
}

/**
 * Removes duplicate and collinear vertices, including retraced stubs. The replacement segment is
 * contained in the checked segments' union, so removing a reversal cannot introduce a card crossing.
 */
export function simplify(points: readonly Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    while (kept.length > 1) {
      const last = kept[kept.length - 1] as Point;
      const before = kept[kept.length - 2] as Point;
      if ((before.x === last.x && last.x === point.x) ||
          (before.y === last.y && last.y === point.y)) kept.pop();
      else break;
    }
    const last = kept[kept.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) kept.push(point);
  }
  return kept;
}

function lerp(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ratio = Math.min(1, distance / length);
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

/** An SVG path through `points` whose turns are rounded to at most `radius`. */
export function roundedPath(points: readonly Point[], radius = 14): string {
  const via = simplify(points);
  const first = via[0];
  if (!first) return "";
  if (via.length === 1) return `M ${first.x},${first.y}`;

  let path = `M ${first.x},${first.y}`;
  for (let index = 1; index < via.length - 1; index += 1) {
    const previous = via[index - 1] as Point;
    const corner = via[index] as Point;
    const next = via[index + 1] as Point;
    const limit = Math.min(
      radius,
      Math.hypot(corner.x - previous.x, corner.y - previous.y) / 2,
      Math.hypot(next.x - corner.x, next.y - corner.y) / 2,
    );
    const entry = lerp(corner, previous, limit);
    const exit = lerp(corner, next, limit);
    path += ` L ${entry.x},${entry.y} Q ${corner.x},${corner.y} ${exit.x},${exit.y}`;
  }

  const last = via[via.length - 1] as Point;
  return `${path} L ${last.x},${last.y}`;
}

export function rightAnglePath(points: readonly Point[]): string {
  const via = simplify(points);
  const first = via[0];
  if (!first) return "";
  return via.slice(1).reduce((path, point) => `${path} L ${point.x},${point.y}`, `M ${first.x},${first.y}`);
}

export function smoothPath(points: readonly Point[], radius = 22): string {
  const via = simplify(points);
  const first = via[0];
  if (!first) return "";
  if (via.length === 1) return `M ${first.x},${first.y}`;

  let path = `M ${first.x},${first.y}`;
  for (let index = 1; index < via.length - 1; index += 1) {
    const previous = via[index - 1] as Point;
    const corner = via[index] as Point;
    const next = via[index + 1] as Point;
    const limit = Math.min(
      radius,
      Math.hypot(corner.x - previous.x, corner.y - previous.y) / 2,
      Math.hypot(next.x - corner.x, next.y - corner.y) / 2,
    );
    const entry = lerp(corner, previous, limit);
    const exit = lerp(corner, next, limit);
    path += ` L ${entry.x},${entry.y} C ${corner.x},${corner.y} ${corner.x},${corner.y} ${exit.x},${exit.y}`;
  }
  const last = via[via.length - 1] as Point;
  return `${path} L ${last.x},${last.y}`;
}

export function pathForStyle(style: EdgeStyle, points: readonly Point[]): string {
  if (style === "right-angle") return rightAnglePath(points);
  if (style === "smooth") return smoothPath(points);
  return roundedPath(points);
}

/** The point half way along the polyline, used to seat the edge label. */
export function midpointOf(points: readonly Point[]): Point {
  const via = simplify(points);
  const first = via[0] ?? { x: 0, y: 0 };
  let total = 0;
  for (let index = 1; index < via.length; index += 1) {
    const from = via[index - 1] as Point;
    const to = via[index] as Point;
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }

  let walked = 0;
  for (let index = 1; index < via.length; index += 1) {
    const from = via[index - 1] as Point;
    const to = via[index] as Point;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (walked + length >= total / 2) return lerp(from, to, total / 2 - walked);
    walked += length;
  }
  return first;
}
