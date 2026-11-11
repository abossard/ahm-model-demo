import type { LiveTimeline } from "./live";
import { addSpan, lowerBound, mergeRange, seriesKey, type EntityInfo, type Point, type StateCode, type StateHistory, type TimelineData, type Transition } from "./timeline";

const CODES: Readonly<Record<string, StateCode>> = { Unknown: 0, Healthy: 1, Degraded: 2, Unhealthy: 3, Deleted: 4 };

export function stateCode(state: string): StateCode {
  return CODES[state] ?? 0;
}

function extend(covered: readonly { readonly from: number; readonly to: number }[], to: number): readonly { readonly from: number; readonly to: number }[] {
  const last = covered[covered.length - 1];
  if (!last || last.to >= to) return covered;
  return addSpan(covered, { from: last.to, to });
}

function insertTransition(held: readonly Transition[], row: Transition): readonly Transition[] {
  if (held.some((item) => item.t === row.t && item.to === row.to && item.from === row.from)) return held;
  const at = lowerBound(held, row.t, (item) => item.t);
  return [...held.slice(0, at), row, ...held.slice(at)];
}

/**
 * What a live delta adds to the timeline the browser holds: new transitions and points go onto histories that are held
 * (a history that was never read is read in full when it is first shown), every held state history is carried forward to
 * `now` because no transition means no change, and the current state of each entity follows the model.
 */
export function applyTimelineDelta(
  data: TimelineData,
  delta: LiveTimeline | undefined,
  now: number,
  current: ReadonlyMap<string, StateCode>,
): TimelineData {
  if (data.entities.length === 0) return data;
  const states: Record<string, StateHistory> = { ...data.states };
  for (const [name, history] of Object.entries(states)) states[name] = { ...history, covered: extend(history.covered, now) };
  for (const row of delta?.transitions ?? []) {
    const held = states[row.entity];
    if (!held) continue;
    states[row.entity] = { ...held, transitions: insertTransition(held.transitions, { t: row.t, from: row.from, to: row.to, reason: row.reason }) };
  }
  const series = { ...data.series };
  for (const item of delta?.points ?? []) {
    const key = seriesKey(item.entity, item.signal);
    const held = series[key];
    if (!held || item.points.length === 0) continue;
    const rows = item.points.map((row): Point => [row[0], row[1], row[2] as StateCode]);
    const first = rows[0]?.[0] ?? 0;
    const last = rows[rows.length - 1]?.[0] ?? first;
    series[key] = {
      ...held,
      points: mergeRange(held.points, rows, { from: first, to: last }, (point) => point[0]),
      covered: extend(held.covered, Math.max(now, last)),
    };
  }
  for (const [key, held] of Object.entries(series)) if (!delta?.points?.some((item) => seriesKey(item.entity, item.signal) === key)) series[key] = { ...held, covered: extend(held.covered, now) };
  const annotations = [...data.annotations];
  for (const row of delta?.annotations ?? []) if (!annotations.some((item) => item.entity === row.entity && item.t === row.t && item.id === row.id)) annotations.push(row);
  const reports = [...data.reports];
  for (const row of delta?.reports ?? []) if (!reports.some((item) => item.entity === row.entity && item.t === row.t && item.reportId === row.reportId)) reports.push(row);
  const entities = data.entities.map((entity): EntityInfo => {
    const state = current.get(entity.name);
    return state === undefined || state === entity.state ? entity : { ...entity, state };
  });
  return {
    ...data,
    entities: entities.every((entity, index) => entity === data.entities[index]) ? data.entities : entities,
    states,
    series,
    annotations: annotations.length === data.annotations.length ? data.annotations : annotations.sort((a, b) => a.t - b.t),
    reports: reports.length === data.reports.length ? data.reports : reports.sort((a, b) => a.t - b.t),
    now: Math.max(data.now, now),
  };
}
