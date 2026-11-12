import { describeRule } from "./timelineHover";
import { bucketSeries, lowerIsWorse, type Buckets } from "./timelineBands";
import type { Point, Rule, SignalInfo, StateCode } from "./timeline";

/** How bad a measured value is: 0 Unknown or no data, 1 Healthy, 2 Degraded, 3 Unhealthy. */
export type Level = 0 | 1 | 2 | 3;

type Rules = SignalInfo["rules"];

const greater = (value: number, threshold: number): boolean => value > threshold;
const COMPARE: Readonly<Record<string, (value: number, threshold: number) => boolean>> = {
  GreaterThan: greater,
  GreaterThanOrEqual: (value, threshold) => value >= threshold,
  LessThan: (value, threshold) => value < threshold,
  LessThanOrEqual: (value, threshold) => value <= threshold,
  Equals: (value, threshold) => value === threshold,
};

const isPast = (value: number, rule: Rule): boolean => (COMPARE[rule.operator] ?? greater)(value, rule.threshold);

const hasThresholds = (rules: Rules): boolean => rules.degraded !== null || rules.unhealthy !== null;

/**
 * The level a measured value falls in: Unhealthy past the unhealthy threshold, Degraded past the degraded one, in the
 * direction the rule compares. Unknown where the state is Unknown or there is no value. A signal without thresholds
 * (a dynamic one) takes the state it reported.
 */
export function levelOf(value: number | null, state: StateCode, rules: Rules): Level {
  if (value === null || state === 0) return 0;
  if (!hasThresholds(rules)) return state === 2 ? 2 : state === 3 ? 3 : 1;
  if (rules.unhealthy && isPast(value, rules.unhealthy)) return 3;
  if (rules.degraded && isPast(value, rules.degraded)) return 2;
  return 1;
}

/** The evaluations of a lane as parallel arrays: where each is (a time or a pixel), its value and its state. */
export interface Vertices {
  readonly x: readonly number[];
  readonly v: readonly (number | null)[];
  readonly s: readonly StateCode[];
}

/** A stretch of the line in one level: the points it passes, in order. A run of one point is a dot. */
export interface ColourRun {
  readonly level: Level;
  readonly xs: readonly number[];
  readonly vs: readonly number[];
}

interface Piece {
  readonly xa: number;
  readonly va: number;
  readonly xb: number;
  readonly vb: number;
  readonly level: Level;
}

/** A line from one evaluation to the next, cut where it crosses a threshold, each piece in the level it lies in. */
function piecesOf(xa: number, va: number, sa: StateCode, xb: number, vb: number, sb: StateCode, rules: Rules): readonly Piece[] {
  const whole = (level: Level): readonly Piece[] => [{ xa, va, xb, vb, level }];
  if (sa === 0 || sb === 0) return whole(0);
  if (!hasThresholds(rules)) return whole(Math.max(levelOf(va, sa, rules), levelOf(vb, sb, rules)) as Level);
  const cuts = [rules.degraded, rules.unhealthy]
    .flatMap((rule) => (rule !== null && (va - rule.threshold) * (vb - rule.threshold) < 0 ? [(rule.threshold - va) / (vb - va)] : []))
    .sort((a, b) => a - b);
  const stops = [0, ...cuts, 1];
  const at = (f: number): readonly [number, number] => [xa + (xb - xa) * f, va + (vb - va) * f];
  return stops.slice(1).map((stop, index) => {
    const from = stops[index] as number;
    const [x0, v0] = at(from);
    const [x1, v1] = at(stop);
    return { xa: x0, va: v0, xb: x1, vb: v1, level: levelOf((v0 + v1) / 2, 1, rules) };
  });
}

/**
 * The line of a lane cut into runs by the level of the value: green where it is healthy, orange past the degraded
 * threshold, red past the unhealthy one, grey where the state is Unknown. A segment that crosses a threshold is cut there.
 * The line breaks at a missing value and where two evaluations are more than `maxGap` apart.
 */
export function colourRuns(vertices: Vertices, rules: Rules, maxGap: number): readonly ColourRun[] {
  const out: ColourRun[] = [];
  let run: { level: Level; xs: number[]; vs: number[] } | null = null;
  let lone: { x: number; v: number; level: Level } | null = null;
  const close = (): void => {
    if (run) out.push(run);
    else if (lone) out.push({ level: lone.level, xs: [lone.x], vs: [lone.v] });
    run = null;
    lone = null;
  };
  let before = -1;
  for (let i = 0; i < vertices.x.length; i += 1) {
    const x = vertices.x[i] as number;
    const v = vertices.v[i] ?? null;
    const s = vertices.s[i] as StateCode;
    if (v === null) {
      close();
      before = -1;
      continue;
    }
    if (before < 0 || x - (vertices.x[before] as number) > maxGap) {
      close();
      lone = { x, v, level: levelOf(v, s, rules) };
      before = i;
      continue;
    }
    for (const piece of piecesOf(vertices.x[before] as number, vertices.v[before] as number, vertices.s[before] as StateCode, x, v, s, rules)) {
      if (run === null || run.level !== piece.level) {
        if (run) out.push(run);
        run = { level: piece.level, xs: [piece.xa], vs: [piece.va] };
        lone = null;
      }
      run.xs.push(piece.xb);
      run.vs.push(piece.vb);
    }
    before = i;
  }
  close();
  return out;
}

/**
 * What a lane draws of a series at one bucket size, made once and read by every frame until the series or the zoom
 * level changes. Its line is in time, not in pixels: a frame only places it.
 */
export interface Lane {
  readonly buckets: Buckets;
  /** The runs of the line by level, each list in time order; the x of a run is a time. */
  readonly runs: readonly (readonly ColourRun[])[];
  /** The level of each bucket: that of its worst end. */
  readonly level: Uint8Array;
  /** A bucket holds three values or more that differ: the line through its first and last value does not show its range. */
  readonly ranges: boolean;
  /** Every bucket is one evaluation: the lane shows the series as it was measured. */
  readonly exact: boolean;
}

/** Folded buckets up to this many apart are joined, when the signal's own hold is shorter. */
const GAP_BUCKETS = 8;

export function laneOf(points: readonly Point[], size: number, rules: Rules, hold: number): Lane {
  const buckets = bucketSeries(points, size);
  const x: number[] = [];
  const v: (number | null)[] = [];
  const s: StateCode[] = [];
  const level = new Uint8Array(buckets.length);
  let ranges = false;
  let exact = true;
  for (let i = 0; i < buckets.length; i += 1) {
    const state = buckets.state[i] as StateCode;
    const many = (buckets.values[i] as number) > 1;
    if (buckets.cut[i] === 1) {
      x.push(buckets.from[i] as number);
      v.push(null);
      s.push(0);
    }
    x.push(buckets.from[i] as number);
    v.push(buckets.first[i] as number);
    s.push(state);
    if (many) {
      x.push(buckets.to[i] as number);
      v.push(buckets.last[i] as number);
      s.push(state);
      exact = false;
    }
    level[i] = Math.max(levelOf(buckets.lo[i] as number, state, rules), levelOf(buckets.hi[i] as number, state, rules));
    if ((buckets.values[i] as number) > 2 && (buckets.hi[i] as number) > (buckets.lo[i] as number)) ranges = true;
  }
  const runs: ColourRun[][] = [[], [], [], []];
  // Folded buckets stand a pixel apart at most, so the line would break between any two of them if only the hold joined them.
  for (const run of colourRuns({ x, v, s }, rules, exact ? hold : Math.max(hold, GAP_BUCKETS * size))) (runs[run.level] as ColourRun[]).push(run);
  return { buckets, runs, level, ranges, exact };
}

export interface ThresholdLine {
  readonly state: 2 | 3;
  readonly value: number;
  /** "Degraded above 70%". */
  readonly text: string;
  /** Which side of its line the label sits: away from the other threshold, so the two never meet. */
  readonly side: "above" | "below";
}

/** The threshold lines a lane draws, each with its words. */
export function thresholdLines(rules: Rules, unit: string | null): readonly ThresholdLine[] {
  const low = lowerIsWorse(rules);
  const both = rules.degraded !== null && rules.unhealthy !== null;
  const line = (state: 2 | 3, rule: Rule | null, side: "above" | "below"): readonly ThresholdLine[] =>
    rule === null ? [] : [{ state, value: rule.threshold, text: `${state === 2 ? "Degraded" : "Unhealthy"} ${describeRule(rule, unit)}`, side }];
  return [
    ...line(2, rules.degraded, both ? (low ? "above" : "below") : low ? "below" : "above"),
    ...line(3, rules.unhealthy, low ? "below" : "above"),
  ];
}
