import type { LiveTimeline } from "./live";
import { lowerBound, mergeRange, seriesKey, upperBound, type EntityInfo, type Point, type Span, type StateCode, type Transition } from "./timeline";
import type { Levels, TimeStore, Track } from "./timeStore";

const CODES: Readonly<Record<string, StateCode>> = { Unknown: 0, Healthy: 1, Degraded: 2, Unhealthy: 3, Deleted: 4 };

export function stateCode(state: string): StateCode {
  return CODES[state] ?? 0;
}

const timeOfRow = (row: { readonly t: number }): number => row.t;
const timeOfPoint = (point: Point): number => point[0];

/**
 * Carries a history that reaches `since` on to `to`: no row means no change. One that ended earlier keeps its gap,
 * which is read when it is shown.
 */
function carry(covered: readonly Span[], since: number, to: number): readonly Span[] {
  const last = covered[covered.length - 1];
  if (!last || last.to >= to || last.to < since) return covered;
  return [...covered.slice(0, -1), { from: last.from, to }];
}

/**
 * What a live event speaks for: the stretch this long before its own instant, a poll and a clock apart. A history is
 * current when it reaches into it. The newest instant held is no measure: after a reload it is where the cache ended.
 */
const LIVE_SLACK = 3 * 60_000;

function insertTransition(held: readonly Transition[], row: Transition): readonly Transition[] {
  if (held.some((item) => item.t === row.t && item.to === row.to && item.from === row.from)) return held;
  const at = lowerBound(held, row.t, timeOfRow);
  return [...held.slice(0, at), row, ...held.slice(at)];
}

function insertMark<T extends { readonly t: number }>(held: readonly T[], row: T, same: (a: T, b: T) => boolean): readonly T[] {
  if (held.some((item) => same(item, row))) return held;
  const at = upperBound(held, row.t, timeOfRow);
  return [...held.slice(0, at), row, ...held.slice(at)];
}

/**
 * What a live delta adds: new rows go onto the histories that are held and current (one that was never read is read in
 * full when it is first shown), every current history is carried forward to `now`, and the state of each entity follows
 * the model.
 */
export function applyLive(store: TimeStore, delta: LiveTimeline | undefined, now: number, current: ReadonlyMap<string, StateCode>): TimeStore {
  if (store.entities.length === 0) return store;
  const since = now - LIVE_SLACK;
  const carried = <T>(tracks: Readonly<Record<string, Track<T>>>): Record<string, Track<T>> => {
    const out: Record<string, Track<T>> = {};
    for (const [name, track] of Object.entries(tracks)) {
      const covered = carry(track.covered, since, now);
      out[name] = covered === track.covered ? track : { ...track, covered };
    }
    return out;
  };
  const isCurrent = (track: Track<unknown> | null | undefined): boolean => {
    const last = track?.covered[track.covered.length - 1];
    return last !== undefined && last.to >= since;
  };

  const states = carried(store.states);
  for (const row of delta?.transitions ?? []) {
    const held = states[row.entity];
    if (!held || !isCurrent(store.states[row.entity])) continue;
    states[row.entity] = { ...held, rows: insertTransition(held.rows, { t: row.t, from: row.from, to: row.to, reason: row.reason }) };
  }
  const annotations = carried(store.annotations);
  for (const row of delta?.annotations ?? []) {
    const held = annotations[row.entity];
    if (!held || !isCurrent(store.annotations[row.entity])) continue;
    annotations[row.entity] = { ...held, rows: insertMark(held.rows, row, (a, b) => a.t === b.t && a.id === b.id) };
  }
  const reports = carried(store.reports);
  for (const row of delta?.reports ?? []) {
    const held = reports[row.entity];
    if (!held || !isCurrent(store.reports[row.entity])) continue;
    reports[row.entity] = { ...held, rows: insertMark(held.rows, row, (a, b) => a.t === b.t && a.reportId === b.reportId) };
  }

  const fresh = new Map((delta?.points ?? []).map((item) => [seriesKey(item.entity, item.signal), item.points.map((row): Point => [row[0], row[1], row[2] as StateCode])]));
  const series: Record<string, Levels> = {};
  for (const [key, levels] of Object.entries(store.series)) {
    const rows = fresh.get(key) ?? [];
    const first = rows[0]?.[0] ?? 0;
    const last = rows[rows.length - 1]?.[0] ?? first;
    let changed = false;
    const next = levels.map((track) => {
      if (!track || !isCurrent(track)) return track;
      const covered = carry(track.covered, since, Math.max(now, last));
      if (rows.length === 0 && covered === track.covered) return track;
      changed = true;
      return { ...track, rows: rows.length === 0 ? track.rows : mergeRange(track.rows, rows, { from: first, to: last }, timeOfPoint), covered };
    });
    series[key] = changed ? next : levels;
  }

  const entities = store.entities.map((entity): EntityInfo => {
    const state = current.get(entity.name);
    return state === undefined || state === entity.state ? entity : { ...entity, state };
  });
  return {
    entities: entities.every((entity, index) => entity === store.entities[index]) ? store.entities : entities,
    states,
    annotations,
    reports,
    series,
    now: Math.max(store.now, now),
    floor: store.floor,
  };
}
