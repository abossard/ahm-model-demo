import type { HealthState } from "./types";

/** The state codes of GET /api/timeline: 0 Unknown, 1 Healthy, 2 Degraded, 3 Unhealthy, 4 Deleted. */
export type StateCode = 0 | 1 | 2 | 3 | 4;

const STATE_BY_CODE: readonly HealthState[] = ["Unknown", "Healthy", "Degraded", "Unhealthy", "Deleted"];
export const HEALTHY: StateCode = 1;
export const UNKNOWN: StateCode = 0;

export function stateName(code: number): HealthState {
  return STATE_BY_CODE[code] ?? "Unknown";
}

/**
 * How bad a state is when several share a pixel or a sort order. A gap in the data (Unknown) ranks above Healthy so
 * it never hides in a pixel, and below Degraded so it never hides trouble.
 */
const SEVERITY: Readonly<Record<StateCode, number>> = { 1: 1, 4: 1, 0: 1.5, 2: 2, 3: 3 };

export function severity(code: StateCode): number {
  return SEVERITY[code];
}

export function worse(a: StateCode, b: StateCode): StateCode {
  return severity(b) > severity(a) ? b : a;
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

export interface Rule {
  readonly operator: string;
  readonly threshold: number;
}

export interface SignalInfo {
  readonly name: string;
  readonly displayName: string;
  readonly kind: string | null;
  readonly unit: string | null;
  readonly refreshInterval: string | null;
  readonly rules: {
    readonly degraded: Rule | null;
    readonly unhealthy: Rule | null;
    readonly dynamic: boolean;
  };
}

export interface EntityInfo {
  readonly name: string;
  readonly displayName: string;
  readonly parents: readonly string[];
  /** The state now. */
  readonly state: StateCode;
  readonly signals: readonly SignalInfo[];
}

export interface Transition {
  readonly t: number;
  readonly from: StateCode;
  readonly to: StateCode;
  readonly reason: string | null;
}

/** One evaluation of a signal: time, value (null when there was no data) and state. */
export type Point = readonly [t: number, value: number | null, state: StateCode];

export interface SeriesError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface Annotation {
  readonly entity: string;
  readonly id: string | null;
  readonly t: number;
  readonly description: string | null;
  readonly details: Readonly<Record<string, string>>;
}

export interface Report {
  readonly entity: string;
  readonly t: number;
  readonly state: StateCode;
  readonly value: number | null;
  readonly reason: string | null;
  readonly reportId: string | null;
}

export interface TimelineResponse {
  readonly model: string;
  readonly observedAt: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly retentionDays: number;
  readonly resolution: number;
  readonly partial: boolean;
  readonly entities: readonly EntityInfo[];
  readonly states: readonly {
    readonly entity: string;
    readonly transitions: readonly Transition[];
    readonly complete: boolean;
    readonly earliest: number | null;
    readonly error?: SeriesError;
  }[];
  readonly series: readonly {
    readonly entity: string;
    readonly signal: string;
    readonly points: readonly Point[];
    readonly complete: boolean;
    readonly earliest: number | null;
    readonly error?: SeriesError;
  }[];
  readonly annotations: readonly Annotation[];
  readonly reports: readonly Report[];
  readonly failures: readonly { readonly entity: string; readonly part: string; readonly error: SeriesError }[];
}

export interface StateHistory {
  readonly transitions: readonly Transition[];
  readonly covered: readonly Span[];
  readonly error: SeriesError | null;
}

export interface SeriesHistory {
  readonly points: readonly Point[];
  readonly covered: readonly Span[];
  readonly error: SeriesError | null;
}

export interface TimelineData {
  readonly entities: readonly EntityInfo[];
  readonly states: Readonly<Record<string, StateHistory>>;
  readonly series: Readonly<Record<string, SeriesHistory>>;
  readonly annotations: readonly Annotation[];
  readonly reports: readonly Report[];
  /** The newest instant any response has covered. */
  readonly now: number;
  /** The oldest instant the service keeps. */
  readonly floor: number;
}

export const EMPTY_TIMELINE: TimelineData = {
  entities: [],
  states: {},
  series: {},
  annotations: [],
  reports: [],
  now: 0,
  floor: 0,
};

export function seriesKey(entity: string, signal: string): string {
  return `${entity}\u0000${signal}`;
}

/** First index whose item time is at or after t, in an array sorted by time. */
export function lowerBound<T>(items: readonly T[], t: number, time: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time(items[mid] as T) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose item time is after t. */
export function upperBound<T>(items: readonly T[], t: number, time: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time(items[mid] as T) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The items of `existing` outside the span, then `incoming` (which the response read inside it), in time order. */
export function mergeRange<T>(
  existing: readonly T[],
  incoming: readonly T[],
  span: Span,
  time: (item: T) => number,
): readonly T[] {
  if (existing.length === 0) return incoming;
  const head = existing.slice(0, lowerBound(existing, span.from, time));
  const tail = existing.slice(upperBound(existing, span.to, time));
  return [...head, ...incoming, ...tail];
}

/** The union of two sorted, disjoint span lists, with touching spans joined. */
export function addSpan(spans: readonly Span[], span: Span): readonly Span[] {
  const out: Span[] = [];
  let merged = span;
  let placed = false;
  for (const current of spans) {
    if (current.to < merged.from) out.push(current);
    else if (current.from > merged.to) {
      if (!placed) {
        out.push(merged);
        placed = true;
      }
      out.push(current);
    } else merged = { from: Math.min(current.from, merged.from), to: Math.max(current.to, merged.to) };
  }
  if (!placed) out.push(merged);
  return out;
}

/** The parts of `want` that no span covers. */
export function missingSpans(covered: readonly Span[], want: Span): readonly Span[] {
  const out: Span[] = [];
  let cursor = want.from;
  for (const span of covered) {
    if (span.to <= cursor) continue;
    if (span.from >= want.to) break;
    if (span.from > cursor) out.push({ from: cursor, to: span.from });
    cursor = Math.max(cursor, span.to);
  }
  if (cursor < want.to) out.push({ from: cursor, to: want.to });
  return out;
}
