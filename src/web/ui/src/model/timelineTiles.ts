import { severity, type Point, type Span } from "./timeline";
import { DAY, HOUR, MINUTE } from "./timelineScale";

/**
 * Time cut into tiles: fixed windows that begin at multiples of their size since the epoch, so the same window is asked
 * for in the same words every time and the browser and the server can keep its answer. A tile that ended a safety margin
 * ago never changes.
 */

export const WEEK = 7 * DAY;
/** The service keeps 30 days and the app's server stops five minutes short of it; ten keeps a request off that edge. */
export const RETENTION = 30 * DAY - 10 * MINUTE;
/** The server calls a window closed this long after it ended: the service may still be writing its last evaluations. */
export const CLOSE_SAFETY = 15 * MINUTE;

export interface Level {
  /** The width of a slot that is thinned to at most five points, in milliseconds. 0 keeps every point. */
  readonly slot: number;
  readonly tile: number;
}

/**
 * The resolutions a series is read at, finest first: every point by the day, slots of 15 minutes by the day, slots of an
 * hour by the week. A tile holds at most a few thousand points of a signal that is evaluated every minute.
 */
export const LEVELS: readonly Level[] = [
  { slot: 0, tile: DAY },
  { slot: 15 * MINUTE, tile: DAY },
  { slot: HOUR, tile: WEEK },
];
export const RAW = 0;
/** States, annotations and reports are sparse and the server keeps them by the week. */
export const OVERVIEW_TILE = WEEK;
/** A slot wider than this many pixels would show as steps. */
const SLOT_PX = 2;

/** The coarsest level whose slots are at most two pixels wide for a window of `span` drawn `width` pixels wide. */
export function levelFor(span: number, width: number): number {
  const perPixel = span / Math.max(1, width);
  for (let level = LEVELS.length - 1; level > RAW; level -= 1) {
    if ((LEVELS[level] as Level).slot <= SLOT_PX * perPixel) return level;
  }
  return RAW;
}

/** The level a response of `resolution` seconds a slot holds: the finest one at least as coarse, raw for 0. */
export function levelOfResolution(seconds: number): number {
  const slot = seconds * 1000;
  const found = LEVELS.findIndex((level) => level.slot >= slot);
  return found < 0 ? LEVELS.length - 1 : found;
}

export const tileOf = (t: number, size: number): number => Math.floor(t / size);

export const tileSpan = (index: number, size: number): Span => ({ from: index * size, to: (index + 1) * size });

/** The tiles a span touches, oldest first. A span that ends on a tile's first instant does not touch it. */
export function tilesIn(span: Span, size: number): readonly number[] {
  if (span.to <= span.from) return [];
  const out: number[] = [];
  for (let index = tileOf(span.from, size); index * size < span.to; index += 1) out.push(index);
  return out;
}

/** Sorted tile indexes as runs of neighbours: `[first, last]` each. */
export function tileRuns(tiles: readonly number[]): readonly (readonly [number, number])[] {
  const out: [number, number][] = [];
  for (const tile of tiles) {
    const last = out[out.length - 1];
    if (last && tile === last[1] + 1) last[1] = tile;
    else out.push([tile, tile]);
  }
  return out;
}

/** A tile read at `readAt` holds everything it ever will. */
export const isClosed = (tile: Span, readAt: number): boolean => readAt >= tile.to + CLOSE_SAFETY;

/**
 * At most five real points per slot: the last of each half, so the kept points stay evenly spaced and a reader that
 * joins a point to the next one sees no hole, then the lowest and the highest value and the worst state. The same
 * rule as `decimate` in the server's timeline.py, for the stubs and for thinning finer points that are already held.
 */
export function decimate(points: readonly Point[], slot: number): readonly Point[] {
  if (slot <= 0 || points.length <= KEEP_WHOLE) return points;
  const out: Point[] = [];
  let start = 0;
  while (start < points.length) {
    const index = Math.floor((points[start] as Point)[0] / slot);
    let end = start + 1;
    while (end < points.length && Math.floor((points[end] as Point)[0] / slot) === index) end += 1;
    if (end - start <= KEEP_WHOLE) for (let i = start; i < end; i += 1) out.push(points[i] as Point);
    else for (const i of picks(points, start, end, index * slot + Math.floor(slot / 2))) out.push(points[i] as Point);
    start = end;
  }
  return out.length === points.length ? points : out;
}

const KEEP_WHOLE = 5;

function picks(points: readonly Point[], start: number, end: number, middle: number): readonly number[] {
  const kept = new Set<number>([end - 1]);
  let early = -1;
  let low = -1;
  let high = -1;
  let worst = start;
  for (let i = start; i < end; i += 1) {
    const point = points[i] as Point;
    if (point[0] < middle) early = i;
    const value = point[1];
    if (value !== null) {
      if (low < 0 || value < ((points[low] as Point)[1] as number)) low = i;
      if (high < 0 || value > ((points[high] as Point)[1] as number)) high = i;
    }
    if (severity(point[2]) > severity((points[worst] as Point)[2])) worst = i;
  }
  for (const i of [early, low, high]) if (i >= 0) kept.add(i);
  const shown = Math.max(...[...kept].map((i) => severity((points[i] as Point)[2])));
  if (severity((points[worst] as Point)[2]) > shown) kept.add(worst);
  return [...kept].sort((a, b) => a - b);
}
