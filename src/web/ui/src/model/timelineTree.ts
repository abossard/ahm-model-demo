import { pointAt, type PixelBand, type ValueDomain } from "./timelineBands";
import { levelOf } from "./timelineLine";
import { describeRules, formatValue } from "./timelineHover";
import type { Point, SeriesHistory, SignalInfo, StateCode } from "./timeline";

export interface SignalFacts {
  readonly state: StateCode | null;
  /** The measured value with its unit; null when the evaluation had none. */
  readonly value: string | null;
  /** The threshold rules as text. */
  readonly rule: string | null;
  /** When that evaluation was made. */
  readonly at: number | null;
}

/** A signal as measured at an instant: its state, its value with the unit, and what the rules say. */
export function signalFacts(info: SignalInfo | undefined, history: SeriesHistory | undefined, asOf: number, hold: number): SignalFacts {
  const rule = info ? describeRules(info.rules, info.unit) : null;
  const point: Point | null = history ? pointAt(history.points, asOf, hold) : null;
  if (!point) return { state: null, value: null, rule, at: null };
  return { state: point[2], value: point[1] === null ? null : formatValue(point[1], info?.unit ?? null), rule, at: point[0] };
}

/** A stretch of a lane's value axis and the state a measured value in it has. */
export interface Zone {
  readonly from: number;
  readonly to: number;
  readonly state: 1 | 2 | 3;
}

/**
 * The value axis of a lane cut by the signal's rule, in value space: the range that is Healthy, the range that is
 * Degraded and the range that is Unhealthy, each as tall as its values are on the lane's y range. Each rule is read in
 * its own direction, so a high value is the bad one for GreaterThan rules and a low one for LessThan rules; a threshold
 * is where one range ends and the next begins, whether the rule includes it or not. A signal without thresholds has no zones.
 * Ordered by value, bottom up.
 */
export function ruleZones(rules: SignalInfo["rules"], domain: ValueDomain): readonly Zone[] {
  if (rules.degraded === null && rules.unhealthy === null) return [];
  const cuts = [rules.degraded, rules.unhealthy]
    .flatMap((rule) => (rule !== null && rule.threshold > domain.lo && rule.threshold < domain.hi ? [rule.threshold] : []))
    .sort((a, b) => a - b);
  const stops = [domain.lo, ...cuts, domain.hi];
  const out: Zone[] = [];
  for (let i = 1; i < stops.length; i += 1) {
    const from = stops[i - 1] as number;
    const to = stops[i] as number;
    if (to <= from) continue;
    const state = levelOf((from + to) / 2, 1, rules) as 1 | 2 | 3;
    const last = out[out.length - 1];
    if (last && last.state === state) out[out.length - 1] = { ...last, to };
    else out.push({ from, to, state });
  }
  return out;
}

/** A piece of a lane's background: columns `x0` to `x1`, and the values it covers, or the whole lane height when `from` is null. */
export interface Wash {
  readonly x0: number;
  readonly x1: number;
  readonly state: StateCode;
  readonly from: number | null;
  readonly to: number | null;
}

/**
 * The pieces of the lane's background that stand out: where the signal had a state, the zone of that state is the
 * stronger one in that stretch of time. Unknown has no zone and is washed over the whole lane height; so is a state the
 * rule has no zone for, and every state of a signal without zones. Deleted is not washed.
 */
export function emphasisOf(spans: readonly PixelBand[], zones: readonly Zone[]): readonly Wash[] {
  const out: Wash[] = [];
  for (const span of spans) {
    if (span.state === 4) continue;
    const own = span.state === 0 ? [] : zones.filter((zone) => zone.state === span.state);
    if (own.length === 0) out.push({ x0: span.x0, x1: span.x1, state: span.state, from: null, to: null });
    else for (const zone of own) out.push({ x0: span.x0, x1: span.x1, state: span.state, from: zone.from, to: zone.to });
  }
  return out;
}
