import {
  lowerBound,
  severity,
  upperBound,
  worse,
  type Point,
  type Rule,
  type SignalInfo,
  type Span,
  type StateCode,
  type Transition,
} from "./timeline";

/** A state held over an interval. */
export interface Band {
  readonly a: number;
  readonly b: number;
  readonly state: StateCode;
}

/** A band in pixels, after sub-pixel runs have been folded into their pixel. */
export interface PixelBand {
  readonly x0: number;
  readonly x1: number;
  readonly state: StateCode;
}

function pushMerged(out: Band[], band: Band): void {
  const last = out[out.length - 1];
  if (last && last.state === band.state && last.b >= band.a) out[out.length - 1] = { a: last.a, b: Math.max(last.b, band.b), state: band.state };
  else out.push(band);
}

/**
 * The bands of an entity from its transitions. Before the first transition it was in that transition's `from` state;
 * with none it has been `current` for the whole span. The history is only known from `span.from`.
 */
export function bandsFromTransitions(
  transitions: readonly Transition[],
  span: Span,
  current: StateCode,
): readonly Band[] {
  const out: Band[] = [];
  const first = transitions[0];
  let state: StateCode = first ? first.from : current;
  let at = span.from;
  for (const transition of transitions) {
    if (transition.t > at) pushMerged(out, { a: at, b: Math.min(transition.t, span.to), state });
    at = Math.max(at, transition.t);
    state = transition.to;
  }
  if (span.to > at) pushMerged(out, { a: at, b: span.to, state });
  return out;
}

const MIN_HOLD = 2 * 60_000;
const MAX_HOLD = 2 * 3600_000;

/** An ISO 8601 duration such as PT5M or P1DT2H as milliseconds; 0 for anything else. */
export function parseDuration(text: string | null): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text ?? "");
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60_000 + Number(seconds ?? 0) * 1000;
}

/**
 * The longest an evaluation is believed to hold: three of the usual intervals (the signal's own refresh interval or what
 * its points show, whichever is longer), between two minutes and two hours. A sparse signal such as a health report is
 * therefore not joined across a day of silence.
 */
export function holdOf(points: readonly Point[], refreshMs = 0): number {
  let typical = refreshMs;
  if (points.length >= 2) {
    const gaps: number[] = [];
    const step = Math.max(1, Math.floor(points.length / 50));
    for (let i = step; i < points.length; i += step) gaps.push(((points[i]?.[0] ?? 0) - (points[i - step]?.[0] ?? 0)) / step);
    gaps.sort((x, y) => x - y);
    typical = Math.max(typical, gaps[Math.floor(gaps.length / 2)] ?? 0);
  }
  return Math.min(MAX_HOLD, Math.max(MIN_HOLD, 3 * typical));
}

/** The bands of a signal: each evaluation holds until the next one, at most `hold`, then there is no data. */
export function bandsFromPoints(points: readonly Point[], hold: number, end: number): readonly Band[] {
  const out: Band[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] as Point;
    const next = i + 1 < points.length ? (points[i + 1] as Point)[0] : end;
    const b = Math.min(next, point[0] + hold);
    if (b > point[0]) pushMerged(out, { a: point[0], b, state: point[2] });
  }
  return out;
}

/** First index whose band ends after t. */
function firstEndingAfter(bands: readonly Band[], t: number): number {
  return upperBound(bands, t, (band) => band.b);
}

/**
 * The bands that fall in `[t0, t1]` as pixel runs for a lane `width` wide. A run narrower than a pixel is folded into
 * its pixel at the worst state it holds, so a short outage never disappears when zoomed out.
 */
export function pixelBands(bands: readonly Band[], t0: number, t1: number, width: number): readonly PixelBand[] {
  const k = width / Math.max(1, t1 - t0);
  const out: PixelBand[] = [];
  let column = -1;
  let columnState: StateCode = 1;

  const flush = (): void => {
    if (column < 0) return;
    const last = out[out.length - 1];
    if (last && last.state === columnState && last.x1 >= column) out[out.length - 1] = { ...last, x1: column + 1 };
    else out.push({ x0: column, x1: column + 1, state: columnState });
    column = -1;
  };

  for (let i = firstEndingAfter(bands, t0); i < bands.length; i += 1) {
    const band = bands[i] as Band;
    if (band.a >= t1) break;
    const x0 = Math.max(0, (band.a - t0) * k);
    const x1 = Math.min(width, (band.b - t0) * k);
    if (x1 <= x0) continue;
    if (x1 - x0 >= 1) {
      flush();
      const last = out[out.length - 1];
      if (last && last.state === band.state && last.x1 >= x0 - 0.5) out[out.length - 1] = { ...last, x1 };
      else out.push({ x0, x1, state: band.state });
    } else {
      const c = Math.floor(x0);
      if (c === column) columnState = worse(columnState, band.state);
      else {
        flush();
        column = c;
        columnState = band.state;
      }
    }
  }
  flush();
  return out;
}

/** The state held at t, or null before the first band and after the last one. */
export function bandAt(bands: readonly Band[], t: number): StateCode | null {
  const i = firstEndingAfter(bands, t);
  const band = bands[i];
  return band && band.a <= t ? band.state : null;
}

/** The last evaluation at or before t that is no older than `hold`. */
export function pointAt(points: readonly Point[], t: number, hold: number): Point | null {
  const i = upperBound(points, t, (point) => point[0]) - 1;
  const point = points[i];
  return point && t - point[0] <= hold ? point : null;
}

/** The sort key of an entity's state: worst first. */
export function worstFirst(state: StateCode): number {
  return -severity(state);
}

export interface Columns {
  /** The pixel column, the lowest and highest value in it, and the first and last in time order. */
  readonly x: number[];
  readonly lo: number[];
  readonly hi: number[];
  readonly first: number[];
  readonly last: number[];
  /** The worst state any point of the column has. */
  readonly state: StateCode[];
}

/** The index range of the points that touch `[t0, t1]`, one point either side so lines run off the edge. */
export function visibleRange(points: readonly Point[], t0: number, t1: number): readonly [number, number] {
  const i0 = Math.max(0, upperBound(points, t0, (point) => point[0]) - 1);
  const i1 = Math.min(points.length, lowerBound(points, t1, (point) => point[0]) + 1);
  return [i0, i1];
}

/** One entry per pixel column that holds a value: the data a lane draws, however many points it came from. */
export function decimateColumns(points: readonly Point[], t0: number, t1: number, width: number): Columns {
  const k = width / Math.max(1, t1 - t0);
  const out: Columns = { x: [], lo: [], hi: [], first: [], last: [], state: [] };
  const [i0, i1] = visibleRange(points, t0, t1);
  let column = Number.NaN;
  for (let i = i0; i < i1; i += 1) {
    const point = points[i] as Point;
    const value = point[1];
    if (value === null) continue;
    const c = Math.floor((point[0] - t0) * k);
    if (c !== column) {
      column = c;
      out.x.push(c);
      out.lo.push(value);
      out.hi.push(value);
      out.first.push(value);
      out.state.push(point[2]);
    } else {
      const n = out.x.length - 1;
      if (value < (out.lo[n] as number)) out.lo[n] = value;
      if (value > (out.hi[n] as number)) out.hi[n] = value;
      out.state[n] = worse(out.state[n] as StateCode, point[2]);
    }
    out.last[out.x.length - 1] = value;
  }
  return out;
}

const BELOW = new Set(["LessThan", "LessThanOrEqual"]);

export function lowerIsWorse(rules: SignalInfo["rules"]): boolean {
  const rule = rules.degraded ?? rules.unhealthy;
  return rule !== null && BELOW.has(rule.operator);
}

export interface ValueDomain {
  readonly lo: number;
  readonly hi: number;
}

/**
 * The y range of a lane: zero based when a high value is the bad one, the data and thresholds when a low one is.
 * A threshold far from the data is left out so it cannot flatten the line.
 */
export function valueDomain(lo: number, hi: number, rules: SignalInfo["rules"]): ValueDomain {
  const thresholds = [rules.degraded, rules.unhealthy].filter((rule): rule is Rule => rule !== null).map((rule) => rule.threshold);
  const reach = Math.max(Math.abs(hi), Math.abs(lo), 1);
  const near = thresholds.filter((threshold) => Math.abs(threshold - (lo + hi) / 2) <= reach * 3);
  let low = lowerIsWorse(rules) ? Math.min(lo, ...near) : Math.min(0, lo);
  let high = Math.max(hi, ...near);
  if (high - low < 1e-9) {
    low -= 0.5;
    high += 0.5;
  }
  const pad = (high - low) * 0.06;
  return { lo: lowerIsWorse(rules) ? low - pad : low, hi: high + pad };
}

export interface MarkerAt<T> {
  readonly x: number;
  readonly item: T;
}

export interface MarkerCluster<T> {
  readonly x: number;
  readonly items: readonly T[];
}

/** Markers sorted by x become clusters at the x of their first member; a cluster spans less than `minPx`. */
export function clusterMarkers<T>(markers: readonly MarkerAt<T>[], minPx: number): readonly MarkerCluster<T>[] {
  const out: { x: number; items: T[] }[] = [];
  for (const marker of markers) {
    const last = out[out.length - 1];
    if (last && marker.x - last.x < minPx) last.items.push(marker.item);
    else out.push({ x: marker.x, items: [marker.item] });
  }
  return out;
}
