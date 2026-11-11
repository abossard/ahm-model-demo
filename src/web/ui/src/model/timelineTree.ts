import { pointAt, type ValueDomain } from "./timelineBands";
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

export interface Zone {
  readonly from: number;
  readonly to: number;
  readonly state: 2 | 3;
}

/**
 * The bands of a lane's y range where a value is Degraded and where it is Unhealthy, so the lane can shade them.
 * A high value is the bad one for GreaterThan rules, a low one for LessThan rules.
 */
export function ruleZones(rules: SignalInfo["rules"], domain: ValueDomain): readonly Zone[] {
  const low = (rules.degraded ?? rules.unhealthy)?.operator.startsWith("LessThan") ?? false;
  const d = rules.degraded?.threshold;
  const u = rules.unhealthy?.threshold;
  const raw: { from: number; to: number; state: 2 | 3 }[] = [];
  if (!low) {
    if (d !== undefined) raw.push({ from: d, to: u ?? domain.hi, state: 2 });
    if (u !== undefined) raw.push({ from: u, to: domain.hi, state: 3 });
  } else {
    if (d !== undefined) raw.push({ from: u ?? domain.lo, to: d, state: 2 });
    if (u !== undefined) raw.push({ from: domain.lo, to: u, state: 3 });
  }
  return raw
    .map((zone) => ({ ...zone, from: Math.max(domain.lo, Math.min(zone.from, zone.to)), to: Math.min(domain.hi, Math.max(zone.from, zone.to)) }))
    .filter((zone) => zone.to > zone.from);
}
