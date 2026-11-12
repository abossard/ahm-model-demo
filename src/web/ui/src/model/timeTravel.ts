import { holdOf, parseDuration } from "./timelineBands";
import { seriesKey, stateName, upperBound, type Point, type Rule, type SeriesHistory, type SignalInfo, type Span, type StateCode, type Transition } from "./timeline";
import { seriesAtLevel, type Levels, type TimeStore, type Track } from "./timeStore";
import type { Entity, EntitySignal, HealthModel } from "./types";

/**
 * The model at a moment: reads of the time-series store that are cheap enough to run on every move of the selected
 * moment. Each is a binary search over rows that are already sorted: nothing is scanned and nothing is copied.
 */

/** An answer and the stretch of time around the moment for which it is the same answer. */
interface Held<T> {
  readonly value: T;
  readonly from: number;
  readonly to: number;
}

const ALWAYS = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };

/** The span that holds t, by binary search. */
function spanAt(covered: readonly Span[], t: number): Span | null {
  const span = covered[upperBound(covered, t, (item) => item.from) - 1];
  return span && t <= span.to ? span : null;
}

function stateHeld(track: Track<Transition> | undefined, t: number, now: number, current: StateCode): Held<StateCode | null> {
  const span = track ? spanAt(track.covered, t) : null;
  if (!track || !span) return { value: null, ...ALWAYS, ...(track ? gapAround(track.covered, t) : {}) };
  const rows = track.rows;
  const after = upperBound(rows, t, (row) => row.t);
  const previous = rows[after - 1];
  const next = rows[after];
  const to = next && next.t <= span.to ? next.t : span.to >= now ? Number.POSITIVE_INFINITY : span.to;
  if (previous && previous.t >= span.from) return { value: previous.to, from: previous.t, to };
  if (next && next.t <= span.to) return { value: next.from, from: span.from, to };
  // Nothing changed from here to the end of what is held: when that end is now, the state is the one the entity has now.
  return { value: span.to >= now ? current : null, from: span.from, to };
}

/** The stretch between two held spans that t falls in: the answer "not held" is the same all through it. */
function gapAround(covered: readonly Span[], t: number): { readonly from: number; readonly to: number } {
  const after = upperBound(covered, t, (item) => item.from);
  return { from: covered[after - 1]?.to ?? Number.NEGATIVE_INFINITY, to: covered[after]?.from ?? Number.POSITIVE_INFINITY };
}

/**
 * The state of an entity at t, from its transitions: what the last change before t led to, or what the next change
 * after t came from, or the state it has now when nothing changed since. Null when the history held does not reach t
 * or cannot say: a reader shows that as Unknown. O(log n).
 */
export function stateAt(track: Track<Transition> | undefined, t: number, now: number, current: StateCode): StateCode | null {
  return stateHeld(track, t, now, current).value;
}

/** A signal as it was evaluated: the last point at or before a moment. */
export interface Reading {
  /** When the evaluation was made. */
  readonly t: number;
  readonly value: number | null;
  readonly state: StateCode;
  /** How long before the moment the evaluation was made, in milliseconds. */
  readonly age: number;
  /** The rule that put it in a Degraded or Unhealthy state, null for any other state. */
  readonly rule: Rule | null;
  /** The evaluation is older than the signal is believed to hold: there was no data at the moment. */
  readonly stale: boolean;
  /** The resolution level it was read from: 0 is the evaluation itself, a higher one a point that stands for its slot. */
  readonly level: number;
}

const holds = new WeakMap<readonly Point[], number>();

/** How long an evaluation of this series is believed to hold: the plot's rule, worked out once per array of points. */
function holdFor(rows: readonly Point[], info: SignalInfo | undefined): number {
  let hold = holds.get(rows);
  if (hold === undefined) {
    hold = holdOf(rows, parseDuration(info?.refreshInterval ?? null));
    holds.set(rows, hold);
  }
  return hold;
}

function readingHeld(levels: Levels | undefined, info: SignalInfo | undefined, t: number): Held<Reading | null> {
  let gap: Held<null> = { value: null, ...ALWAYS };
  for (let level = 0; level < (levels?.length ?? 0); level += 1) {
    const track = levels?.[level];
    if (!track) continue;
    const span = spanAt(track.covered, t);
    if (!span) {
      const around = gapAround(track.covered, t);
      gap = { value: null, from: Math.max(gap.from, around.from), to: Math.min(gap.to, around.to) };
      continue;
    }
    const after = upperBound(track.rows, t, (row) => row[0]);
    const point = track.rows[after - 1];
    const next = track.rows[after];
    const to = next && next[0] <= span.to ? next[0] : span.to;
    if (!point || point[0] < span.from) return { value: null, from: span.from, to };
    const rule = point[2] === 3 ? (info?.rules.unhealthy ?? null) : point[2] === 2 ? (info?.rules.degraded ?? null) : null;
    const hold = holdFor(track.rows, info);
    const stale = t - point[0] > hold;
    // The reading turns stale when it is older than it holds: that instant ends the stretch too.
    return { value: { t: point[0], value: point[1], state: point[2], age: t - point[0], rule, stale, level }, from: stale ? point[0] + hold : point[0], to: stale ? to : Math.min(to, point[0] + hold) };
  }
  return gap;
}

/**
 * The value and state of a signal at t: the last evaluation at or before t, from the finest level that holds t, with its
 * age and the rule that judged it. Null when no level holds t or nothing was evaluated yet. O(log n).
 */
export function signalAt(levels: Levels | undefined, info: SignalInfo | undefined, t: number): Reading | null {
  return readingHeld(levels, info, t).value;
}

/**
 * The series to read a signal from at t: the finest level that holds t, in the shape the plot's own readers take. A view
 * drawn from thinned points shows the evaluation itself at a selected moment this way. Undefined when no level holds t.
 */
export function historyAt(levels: Levels | undefined, t: number): SeriesHistory | undefined {
  for (let level = 0; level < (levels?.length ?? 0); level += 1) {
    const track = levels?.[level];
    if (track && spanAt(track.covered, t)) return seriesAtLevel(levels as Levels, level);
  }
  return undefined;
}

/** The state of every entity at t, by name: Unknown (0) where the history held does not say. O(entities · log n). */
export function statesAt(store: TimeStore, t: number): ReadonlyMap<string, StateCode> {
  return new Map(store.entities.map((entity) => [entity.name, stateAt(store.states[entity.name], t, store.now, entity.state) ?? 0]));
}

interface Memo {
  readonly model: HealthModel;
  readonly store: TimeStore;
  readonly result: HealthModel;
  readonly from: number;
  readonly to: number;
  /** The entity the result holds for each entity of the model, by the model's own object. */
  readonly made: ReadonlyMap<Entity, Entity>;
}

function sameSignals(a: readonly EntitySignal[], b: readonly EntitySignal[]): boolean {
  return a.length === b.length && a.every((signal, index) => signal === b[index] || (signal.value === b[index]?.value && signal.healthState === b[index]?.healthState && signal.reportedAt === b[index]?.reportedAt));
}

/**
 * Makes a `modelAt`: the health model the graph views take, as it was at a moment. The entities and relationships are
 * the ones the model has now (the service keeps no history of the structure); the state of every entity, the value and
 * state of every signal and the model's own state (that of its root entity) are those of the moment. A signal whose
 * history at the moment is not held reads as Unknown with no value, never as its value of now.
 *
 * It remembers its last answer: a null moment gives the live model itself, a moment that crosses no transition and no
 * evaluation gives the same object again (without looking anything up), and after any other move every entity that
 * did not change keeps its identity. Each view that reads it makes its own, or shares `modelAt`.
 */
export function createModelAt(): (model: HealthModel, store: TimeStore, t: number | null) => HealthModel {
  let memo: Memo | null = null;
  return (model, store, t) => {
    if (t === null) return model;
    if (memo && memo.model === model && memo.store === store && t >= memo.from && t < memo.to) return memo.result;
    const before = memo?.made ?? null;
    const info = new Map(store.entities.map((entity) => [entity.name, entity]));
    const made = new Map<Entity, Entity>();
    let from = Number.NEGATIVE_INFINITY;
    let to = Number.POSITIVE_INFINITY;
    // Everything of the model that is not an entity's health: when it differs, the answer is a new object around the same entities.
    let changed =
      memo === null ||
      memo.model.entities.length !== model.entities.length ||
      memo.model.relationships !== model.relationships ||
      memo.model.reportOptions !== model.reportOptions ||
      memo.model.model !== model.model;
    let rootState: StateCode = 0;
    const entities = model.entities.map((entity, index) => {
      const known = info.get(entity.name);
      const state = stateHeld(store.states[entity.name], t, store.now, known?.state ?? 0);
      from = Math.max(from, state.from);
      to = Math.min(to, state.to);
      const signals = entity.signals.map((signal): EntitySignal => {
        const reading = readingHeld(store.series[seriesKey(entity.name, signal.name)], known?.signals.find((item) => item.name === signal.name), t);
        from = Math.max(from, reading.from);
        to = Math.min(to, reading.to);
        const shown = reading.value && !reading.value.stale ? reading.value : null;
        return { ...signal, value: shown?.value ?? null, healthState: stateName(shown?.state ?? 0), reportedAt: shown ? new Date(shown.t).toISOString() : null };
      });
      const healthState = stateName(state.value ?? 0);
      if (entity.name === model.model.name) rootState = state.value ?? 0;
      const last = before?.get(entity);
      const same = last !== undefined && last.healthState === healthState && sameSignals(last.signals, signals);
      const out = same ? last : { ...entity, healthState, signals };
      if (memo?.result.entities[index] !== out) changed = true;
      made.set(entity, out);
      return out;
    });
    const healthState = stateName(rootState);
    const result = !changed && memo && memo.result.model.healthState === healthState ? memo.result : { ...model, model: { ...model.model, healthState }, observedAt: new Date(t).toISOString(), entities };
    memo = { model, store, result, from, to, made };
    return result;
  };
}

/** The `modelAt` the app shares, so every view of one moment gets the same objects. */
export const modelAt = createModelAt();
