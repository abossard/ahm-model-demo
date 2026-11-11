import { bandAt, pointAt, type Band } from "./timelineBands";
import { severity, stateName, type Annotation, type EntityInfo, type Report, type Rule, type SeriesHistory, type SignalInfo, type StateCode, type Transition } from "./timeline";
import type { Row } from "./timelineRows";

export interface TipLine {
  readonly key: string;
  readonly kind: "entity" | "signal";
  readonly label: string;
  readonly context: string | null;
  readonly state: StateCode | null;
  /** The value and its unit, for a signal that has one at that instant. */
  readonly value: string | null;
}

export interface TipMarker {
  readonly kind: "annotation" | "report" | "change" | "incident";
  readonly entity: string;
  readonly t: number;
  readonly text: string;
}

export interface Tip {
  readonly t: number;
  readonly lines: readonly TipLine[];
  /** Rows that were left out: all of them healthy or beyond the cap. */
  readonly hidden: number;
  readonly markers: readonly TipMarker[];
}

export interface TipInput {
  readonly t: number;
  /** The rows to read: those that show. */
  readonly rows: readonly Row[];
  readonly entities: ReadonlyMap<string, EntityInfo>;
  readonly bandsOf: (entity: EntityInfo) => readonly Band[];
  readonly seriesOf: (entity: string, signal: string) => SeriesHistory | undefined;
  readonly hoveredKey: string | null;
  readonly maxLines: number;
  /** How long an evaluation is believed, per series. */
  readonly holdOf: (history: SeriesHistory) => number;
}

const UNITS: Readonly<Record<string, string>> = { Percent: "%", MilliSeconds: " ms", Seconds: " s", Count: "", Bytes: " B", BytesPerSecond: " B/s", CountPerSecond: "/s" };

/** A value as a short number with its unit: three significant digits, no trailing zeros. */
export function formatValue(value: number, unit: string | null): string {
  const text = Number(value.toPrecision(3)).toString();
  return `${text}${unit === null ? "" : (UNITS[unit] ?? ` ${unit}`)}`;
}

const DIRECTION: Readonly<Record<string, string>> = {
  GreaterThan: "above",
  GreaterThanOrEqual: "at or above",
  LessThan: "below",
  LessThanOrEqual: "at or below",
  Equals: "at",
};

/** What a threshold says, in words and with the unit: "above 70%". */
export function describeRule(rule: Rule, unit: string | null): string {
  return `${DIRECTION[rule.operator] ?? "above"} ${formatValue(rule.threshold, unit)}`;
}

/** What the thresholds of a signal say, for a tooltip: "Degraded above 70%, Unhealthy above 90%". */
export function describeRules(rules: SignalInfo["rules"], unit: string | null): string | null {
  const parts: string[] = [];
  if (rules.degraded) parts.push(`Degraded ${describeRule(rules.degraded, unit)}`);
  if (rules.unhealthy) parts.push(`Unhealthy ${describeRule(rules.unhealthy, unit)}`);
  if (rules.dynamic) parts.push("Dynamic threshold");
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Every lane that shows, read at one instant. The row under the pointer comes first, then the rows in trouble, worst
 * first; healthy ones fill what is left of `maxLines` and the rest are counted.
 */
export function tooltipLines(input: TipInput): Pick<Tip, "lines" | "hidden"> {
  const lines: TipLine[] = [];
  for (const row of input.rows) {
    const entity = input.entities.get(row.entity);
    if (!entity) continue;
    if (row.kind === "entity") {
      lines.push({ key: row.key, kind: "entity", label: entity.displayName, context: null, state: bandAt(input.bandsOf(entity), input.t), value: null });
      continue;
    }
    const info = entity.signals.find((signal) => signal.name === row.signal);
    const held = input.seriesOf(row.entity, row.signal);
    const point = held ? pointAt(held.points, input.t, input.holdOf(held)) : null;
    lines.push({
      key: row.key,
      kind: "signal",
      label: info?.displayName ?? row.signal,
      context: entity.displayName,
      state: point ? point[2] : null,
      value: point && point[1] !== null ? formatValue(point[1], info?.unit ?? null) : null,
    });
  }
  const rank = (line: TipLine): number => (line.key === input.hoveredKey ? 100 : line.state === null ? 0 : severity(line.state));
  const ordered = lines.map((line, index) => ({ line, index })).sort((a, b) => rank(b.line) - rank(a.line) || a.index - b.index);
  const kept = ordered.slice(0, input.maxLines).map((item) => item.line);
  return { lines: kept, hidden: ordered.length - kept.length };
}

export interface TipMarkerInput {
  readonly annotations: readonly Annotation[];
  readonly reports: readonly Report[];
  /** The state changes that are marked: those of the selected entity. */
  readonly changes: readonly Transition[];
  readonly entity: string;
  readonly t0: number;
  readonly t1: number;
}

/** "Healthy to Degraded", and the reason when the service gave one. */
export function describeChange(change: Transition): string {
  return `${stateName(change.from)} to ${stateName(change.to)}${change.reason ? `: ${change.reason}` : ""}`;
}

/** The markers of one entity that fall in `[t0, t1]`, oldest first. */
export function markersOf(input: TipMarkerInput): readonly TipMarker[] {
  const notes = input.annotations
    .filter((item) => item.entity === input.entity && item.t >= input.t0 && item.t <= input.t1)
    .map((item): TipMarker => ({ kind: "annotation", entity: item.entity, t: item.t, text: item.description ?? "Annotation" }));
  const reports = input.reports
    .filter((item) => item.entity === input.entity && item.t >= input.t0 && item.t <= input.t1)
    .map((item): TipMarker => ({ kind: "report", entity: item.entity, t: item.t, text: `${stateName(item.state)} report${item.reason ? `: ${item.reason}` : ""}` }));
  const changes = input.changes
    .filter((item) => item.t >= input.t0 && item.t <= input.t1)
    .map((item): TipMarker => ({ kind: "change", entity: input.entity, t: item.t, text: describeChange(item) }));
  return [...notes, ...reports, ...changes].sort((a, b) => a.t - b.t);
}
