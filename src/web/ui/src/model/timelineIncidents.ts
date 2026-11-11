import { formatDuration } from "./duration";
import { bandAt, bandsFromTransitions, type Band } from "./timelineBands";
import {
  missingSpans,
  seriesKey,
  stateName,
  type EntityInfo,
  type Span,
  type StateCode,
  type TimelineData,
} from "./timeline";
import type { HealthState } from "./types";

export interface Incident {
  readonly id: string;
  readonly from: number;
  /** Null while it is still going. */
  readonly to: number | null;
  readonly peak: 2 | 3;
}

const NON_HEALTHY = new Set<StateCode>([2, 3]);

/**
 * The incidents in a band list: contiguous spans in a Degraded or Unhealthy state. Bands that touch are one incident,
 * and so are two that a healthy gap of at most `joinGap` ms separates, so a flapping root is one story.
 */
export function detectIncidents(bands: readonly Band[], now: number, joinGap = 0): readonly Incident[] {
  const out: { from: number; to: number; peak: 2 | 3; open: boolean }[] = [];
  for (const band of bands) {
    if (!NON_HEALTHY.has(band.state)) continue;
    const last = out[out.length - 1];
    const peak = band.state === 3 ? 3 : 2;
    if (last && band.a - last.to <= joinGap) {
      last.to = band.b;
      last.peak = last.peak === 3 ? 3 : peak;
      last.open = band.b >= now;
    } else out.push({ from: band.a, to: band.b, peak, open: band.b >= now });
  }
  return out.map((incident) => ({ id: `i:${incident.from}`, from: incident.from, to: incident.open ? null : incident.to, peak: incident.peak }));
}

/** An incident in words: "Ongoing, 1 h 33 min, peak Unhealthy". */
export function incidentText(incident: Incident, now: number): string {
  const length = formatDuration((incident.to ?? now) - incident.from);
  return `${incident.to === null ? "Ongoing, " : ""}${length}, peak ${stateName(incident.peak)}`;
}

/** The span a held history covers: from its oldest covered instant to the newest. */
export function coveredSpan(covered: readonly Span[], fallback: Span): Span {
  const first = covered[0];
  const last = covered[covered.length - 1];
  return first && last ? { from: first.from, to: last.to } : fallback;
}

/** The bands of every entity, from its held transitions, over the span the history covers. */
export function entityBands(data: TimelineData, entity: EntityInfo): readonly Band[] {
  const history = data.states[entity.name];
  if (!history) return [];
  const covered = coveredSpan(history.covered, { from: data.floor, to: data.now });
  // The last state holds up to now: a quiet entity has no newer transition to say otherwise.
  const span = { from: covered.from, to: Math.max(covered.to, data.now) };
  return bandsFromTransitions(history.transitions, span, entity.state);
}

export interface ModelRow {
  readonly entity: string;
  readonly displayName: string;
  readonly state: HealthState;
  readonly code: StateCode;
}

/** The model as it was at t: the state of every entity then, in model order. Unknown where nothing is held. */
export function modelAt(data: TimelineData, t: number, bandsOf: (entity: EntityInfo) => readonly Band[]): readonly ModelRow[] {
  return data.entities.map((entity) => {
    const code = bandAt(bandsOf(entity), t) ?? 0;
    return { entity: entity.name, displayName: entity.displayName, state: stateName(code), code };
  });
}

/** The window to ask the service for so that a view's signals are covered, or null when every one already is. */
export function planSignals(
  data: TimelineData,
  entities: readonly string[],
  want: Span,
): { readonly entities: readonly string[]; readonly span: Span } | null {
  const lacking: string[] = [];
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const byName = new Map(data.entities.map((entity) => [entity.name, entity]));
  for (const name of entities) {
    const info = byName.get(name);
    if (!info) continue;
    let needs = false;
    for (const signal of info.signals) {
      const held = data.series[seriesKey(name, signal.name)];
      if (held?.error) continue;
      const gaps = missingSpans(held?.covered ?? [], want).filter((gap) => gap.to - gap.from > staleMs(want));
      for (const gap of gaps) {
        needs = true;
        from = Math.min(from, gap.from);
        to = Math.max(to, gap.to);
      }
    }
    if (needs) lacking.push(name);
  }
  return lacking.length === 0 ? null : { entities: lacking, span: { from, to } };
}

/** A gap narrower than this is the newest minutes not yet read, not missing history. */
function staleMs(want: Span): number {
  return Math.max(2 * 60_000, (want.to - want.from) / 200);
}

/** Splits entities into requests of at most `maxSignals` signals each (an entity with more goes alone). */
export function batchEntities(
  data: TimelineData,
  names: readonly string[],
  maxSignals: number,
): readonly (readonly string[])[] {
  const counts = new Map(data.entities.map((entity) => [entity.name, entity.signals.length]));
  const batches: string[][] = [];
  let load = 0;
  for (const name of names) {
    const count = counts.get(name) ?? 0;
    const last = batches[batches.length - 1];
    if (last && load + count <= maxSignals) {
      last.push(name);
      load += count;
    } else {
      batches.push([name]);
      load = count;
    }
  }
  return batches;
}
