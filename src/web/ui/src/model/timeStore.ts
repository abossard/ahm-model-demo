import {
  addSpan,
  lowerBound,
  mergeRange,
  missingSpans,
  seriesKey,
  upperBound,
  type Annotation,
  type EntityInfo,
  type Point,
  type Report,
  type SeriesError,
  type SeriesHistory,
  type Span,
  type StateHistory,
  type TimelineData,
  type TimelineResponse,
  type Transition,
} from "./timeline";
import { LEVELS, decimate, levelOfResolution, type Level } from "./timelineTiles";

/**
 * Everything the browser holds about a model over time, keyed by what it is and never by where it is shown: the state
 * history of an entity by its name, a series by entity and signal, the entities and their signal definitions once. A row
 * of the tree, a node of the graph or a lane of the plot points at an entry here, so an entity under five parents is
 * held once.
 */

/** One history: its rows oldest first and the spans of time they are known for. A span with no row in it is a quiet one. */
export interface Track<T> {
  readonly rows: readonly T[];
  readonly covered: readonly Span[];
  readonly error: SeriesError | null;
}

export interface TimeStore {
  /** The reference data: every entity with its parents, signals, rules and units, in the model's order. */
  readonly entities: readonly EntityInfo[];
  readonly states: Readonly<Record<string, Track<Transition>>>;
  readonly annotations: Readonly<Record<string, Track<Annotation>>>;
  readonly reports: Readonly<Record<string, Track<Report>>>;
  /** By `seriesKey(entity, signal)`: one track per resolution level, null where that level was never read. */
  readonly series: Readonly<Record<string, Levels>>;
  /** The newest instant anything was read or heard for. */
  readonly now: number;
  /** The oldest instant anything was read for. */
  readonly floor: number;
}

export type Levels = readonly (Track<Point> | null)[];

export const EMPTY_STORE: TimeStore = { entities: [], states: {}, annotations: {}, reports: {}, series: {}, now: 0, floor: 0 };

export type Part = "structure" | "states" | "annotations" | "reports" | "signals";

/** What a request asked for: the answer is read against it, because a quiet history has no row to say it was read. */
export interface Asked {
  readonly parts: readonly Part[];
  /** Null asks for every entity of the model. */
  readonly entities: readonly string[] | null;
  /** Null asks for every signal of those entities. */
  readonly signals: readonly string[] | null;
  readonly level: number;
}

const EMPTY_TRACK: Track<never> = { rows: [], covered: [], error: null };
const timeOfRow = (row: { readonly t: number }): number => row.t;
const timeOfPoint = (point: Point): number => point[0];
const NOT_ANSWERED: SeriesError = { code: "not_found", message: "This history does not exist.", retryable: false };

function put<T>(track: Track<T> | null | undefined, rows: readonly T[], span: Span, time: (row: T) => number): Track<T> {
  const held = track ?? (EMPTY_TRACK as Track<T>);
  return { rows: mergeRange(held.rows, rows, span, time), covered: addSpan(held.covered, span), error: null };
}

const failed = <T>(track: Track<T> | null | undefined, error: SeriesError): Track<T> => ({ ...(track ?? (EMPTY_TRACK as Track<T>)), error });

/** Whether the spans hold all of `want`. */
export const covers = (covered: readonly Span[], want: Span): boolean => want.to <= want.from || missingSpans(covered, want).length === 0;

/** The spans a series is held for at `level` or finer: finer points can always be thinned. */
export function coveredAt(levels: Levels | undefined, level: number): readonly Span[] {
  let out: readonly Span[] = [];
  for (let l = 0; l <= level; l += 1) for (const span of levels?.[l]?.covered ?? []) out = addSpan(out, span);
  return out;
}

function withLevel(levels: Levels | undefined, level: number, track: Track<Point>): Levels {
  const out: (Track<Point> | null)[] = LEVELS.map((_unused, index) => levels?.[index] ?? null);
  out[level] = track;
  return out;
}

const sameText = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * An entity as it was just read, made of the objects that are already held wherever they say the same: the plot keeps
 * what it worked out for a signal by the identity of the signal and of its rules, so a re-read must not replace them.
 */
function shared(held: EntityInfo | undefined, next: EntityInfo): EntityInfo {
  if (!held) return next;
  const before = new Map(held.signals.map((signal) => [signal.name, signal]));
  const signals = next.signals.map((signal) => {
    const old = before.get(signal.name);
    return old && sameText(old, signal) ? old : signal;
  });
  const sameSignals = signals.length === held.signals.length && signals.every((signal, index) => signal === held.signals[index]);
  if (sameSignals && held.displayName === next.displayName && held.state === next.state && sameText(held.parents, next.parents)) return held;
  return { ...next, signals: sameSignals ? held.signals : signals };
}

/** The structure after an answer: the whole list when the answer is for the whole model, else what it names over what is held. */
function mergeEntities(held: readonly EntityInfo[], incoming: readonly EntityInfo[], whole: boolean): readonly EntityInfo[] {
  const known = new Map(held.map((entity) => [entity.name, entity]));
  const fresh = new Map(incoming.map((entity) => [entity.name, shared(known.get(entity.name), entity)]));
  const next = whole || held.length === 0 ? [...fresh.values()] : [...held.map((entity) => fresh.get(entity.name) ?? entity), ...[...fresh.values()].filter((entity) => !known.has(entity.name))];
  return next.length === held.length && next.every((entity, index) => entity === held[index]) ? held : next;
}

function byEntity<T extends { readonly entity: string }>(rows: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.entity);
    if (list) list.push(row);
    else out.set(row.entity, [row]);
  }
  return out;
}

/**
 * What an answer of GET /api/timeline adds. Rows inside the answer's window replace the held ones (a later read revises
 * the newest), and every history that was asked for is marked as read for that window, also when it has no row in it.
 * A history the answer does not name does not exist. One the service cut at its old end is held from its oldest row.
 */
export function mergeAnswer(store: TimeStore, response: TimelineResponse, asked: Asked): TimeStore {
  const range = { from: Date.parse(response.range.from), to: Date.parse(response.range.to) };
  const entities = response.entities.length === 0 ? store.entities : mergeEntities(store.entities, response.entities, asked.entities === null);
  // An answer for the whole model names its entities itself: in its structure, or in the states it carries.
  const names = asked.entities ?? [...new Set([...entities.map((entity) => entity.name), ...response.states.map((item) => item.entity)])];
  const wanted = new Set(names);
  const part = (name: Part): boolean => asked.parts.includes(name);

  let states = store.states;
  if (part("states")) {
    const next = { ...states };
    const answered = new Set<string>();
    for (const item of response.states) {
      answered.add(item.entity);
      next[item.entity] = item.error
        ? failed(next[item.entity], item.error)
        : put(next[item.entity], item.transitions, { from: item.complete ? range.from : (item.earliest ?? range.to), to: range.to }, timeOfRow);
    }
    for (const name of names) if (!answered.has(name)) next[name] = failed(next[name], NOT_ANSWERED);
    states = next;
  }

  const marks = <T extends { readonly entity: string; readonly t: number }>(
    held: Readonly<Record<string, Track<T>>>,
    name: "annotations" | "reports",
    rows: readonly T[],
  ): Readonly<Record<string, Track<T>>> => {
    if (!part(name)) return held;
    const next = { ...held };
    const grouped = byEntity(rows);
    const errors = new Map(response.failures.filter((failure) => failure.part === name).map((failure) => [failure.entity, failure.error]));
    for (const entity of new Set([...names, ...grouped.keys()])) {
      if (!wanted.has(entity) && asked.entities !== null) continue;
      const error = errors.get(entity);
      next[entity] = error && error.code !== "truncated" ? failed(next[entity], error) : put(next[entity], grouped.get(entity) ?? [], range, timeOfRow);
    }
    return next;
  };

  let series = store.series;
  if (part("signals")) {
    const next = { ...series };
    const level = levelOfResolution(response.resolution);
    const answered = new Set<string>();
    for (const item of response.series) {
      const key = seriesKey(item.entity, item.signal);
      answered.add(key);
      const held = next[key]?.[level];
      const track = item.error
        ? failed(held, item.error)
        : put(held, item.points, { from: item.complete ? range.from : (item.earliest ?? range.to), to: range.to }, timeOfPoint);
      next[key] = withLevel(next[key], level, track);
    }
    for (const entity of entities) {
      if (!wanted.has(entity.name)) continue;
      for (const signal of entity.signals) {
        const key = seriesKey(entity.name, signal.name);
        if (answered.has(key) || (asked.signals !== null && !asked.signals.includes(signal.name))) continue;
        next[key] = withLevel(next[key], asked.level, failed(next[key]?.[asked.level], NOT_ANSWERED));
      }
    }
    series = next;
  }

  return {
    entities,
    states,
    annotations: marks(store.annotations, "annotations", response.annotations),
    reports: marks(store.reports, "reports", response.reports),
    series,
    now: Math.max(store.now, range.to),
    floor: store.floor === 0 ? range.from : Math.min(store.floor, range.from),
  };
}

/** A tile the browser kept: the rows of one history inside the span that was read. */
export interface KeptTile {
  readonly kind: "states" | "annotations" | "reports" | "series";
  readonly entity: string;
  readonly signal: string | null;
  readonly level: number;
  readonly span: Span;
  readonly rows: readonly unknown[];
}

/** What tiles the browser kept add to the store: the same merge as an answer, a tile at a time. */
export function mergeKept(store: TimeStore, tiles: readonly KeptTile[]): TimeStore {
  if (tiles.length === 0) return store;
  const states = { ...store.states };
  const annotations = { ...store.annotations };
  const reports = { ...store.reports };
  const series = { ...store.series };
  let now = store.now;
  let floor = store.floor;
  for (const tile of tiles) {
    if (tile.kind === "states") states[tile.entity] = put(states[tile.entity], tile.rows as readonly Transition[], tile.span, timeOfRow);
    else if (tile.kind === "annotations") annotations[tile.entity] = put(annotations[tile.entity], tile.rows as readonly Annotation[], tile.span, timeOfRow);
    else if (tile.kind === "reports") reports[tile.entity] = put(reports[tile.entity], tile.rows as readonly Report[], tile.span, timeOfRow);
    else {
      const key = seriesKey(tile.entity, tile.signal ?? "");
      series[key] = withLevel(series[key], tile.level, put(series[key]?.[tile.level], tile.rows as readonly Point[], tile.span, timeOfPoint));
    }
    now = Math.max(now, tile.span.to);
    floor = floor === 0 ? tile.span.from : Math.min(floor, tile.span.from);
  }
  return { ...store, states, annotations, reports, series, now, floor };
}

/** The tiles of an answer, for the browser to keep: one per history and tile, cut to what the answer read of it. */
export function tilesOfAnswer(response: TimelineResponse, asked: Asked, tileSize: { readonly overview: number; readonly series: (level: number) => number }): readonly KeptTile[] {
  const range = { from: Date.parse(response.range.from), to: Date.parse(response.range.to) };
  const out: KeptTile[] = [];
  const cut = <T>(kind: KeptTile["kind"], entity: string, signal: string | null, level: number, size: number, rows: readonly T[], time: (row: T) => number): void => {
    for (let index = Math.floor(range.from / size); index * size < range.to; index += 1) {
      const span = { from: Math.max(range.from, index * size), to: Math.min(range.to, (index + 1) * size) };
      out.push({ kind, entity, signal, level, span, rows: rows.slice(lowerBound(rows, span.from, time), span.to === range.to ? rows.length : lowerBound(rows, span.to, time)) });
    }
  };
  if (asked.parts.includes("states")) {
    for (const item of response.states) if (!item.error && item.complete) cut("states", item.entity, null, 0, tileSize.overview, item.transitions, timeOfRow);
  }
  const marks = (kind: "annotations" | "reports", rows: readonly (Annotation | Report)[]): void => {
    if (!asked.parts.includes(kind)) return;
    const bad = new Set(response.failures.filter((failure) => failure.part === kind).map((failure) => failure.entity));
    const grouped = byEntity(rows);
    for (const entity of asked.entities ?? response.states.map((item) => item.entity)) {
      if (!bad.has(entity)) cut(kind, entity, null, 0, tileSize.overview, grouped.get(entity) ?? [], timeOfRow);
    }
  };
  marks("annotations", response.annotations);
  marks("reports", response.reports);
  if (asked.parts.includes("signals")) {
    const level = levelOfResolution(response.resolution);
    for (const item of response.series) if (!item.error && item.complete) cut("series", item.entity, item.signal, level, tileSize.series(level), item.points, timeOfPoint);
  }
  return out;
}

/**
 * Clears the errors of the histories of some entities (all when `names` is null), so they are asked for again. With
 * `passing` only the errors that may pass on their own are cleared: a history the caller may not read stays refused.
 */
export function clearErrors(store: TimeStore, names: readonly string[] | null, passing = false): TimeStore {
  const wanted = names === null ? null : new Set(names);
  const clear = (error: SeriesError | null): boolean => error !== null && (!passing || error.retryable);
  const cleared = <T>(tracks: Readonly<Record<string, Track<T>>>): Readonly<Record<string, Track<T>>> => {
    let out: Record<string, Track<T>> | null = null;
    for (const [name, track] of Object.entries(tracks)) {
      if (!clear(track.error) || (wanted !== null && !wanted.has(name))) continue;
      out ??= { ...tracks };
      out[name] = { ...track, error: null };
    }
    return out ?? tracks;
  };
  let series: Record<string, Levels> | null = null;
  for (const entity of store.entities) {
    if (wanted !== null && !wanted.has(entity.name)) continue;
    for (const signal of entity.signals) {
      const key = seriesKey(entity.name, signal.name);
      const levels = store.series[key];
      if (!levels?.some((track) => clear(track?.error ?? null))) continue;
      series ??= { ...store.series };
      series[key] = levels.map((track) => (track && clear(track.error) ? { ...track, error: null } : track));
    }
  }
  const states = cleared(store.states);
  const annotations = cleared(store.annotations);
  const reports = cleared(store.reports);
  return series === null && states === store.states && annotations === store.annotations && reports === store.reports ? store : { ...store, states, annotations, reports, series: series ?? store.series };
}

/** Names the series a failed request asked for, so each lane says why it is empty and none is asked again until retried. */
export function markFailed(store: TimeStore, asked: Asked, error: SeriesError): TimeStore {
  if (!asked.parts.includes("signals")) return store;
  const wanted = new Set(asked.entities ?? store.entities.map((entity) => entity.name));
  const series = { ...store.series };
  for (const entity of store.entities) {
    if (!wanted.has(entity.name)) continue;
    for (const signal of entity.signals) {
      if (asked.signals !== null && !asked.signals.includes(signal.name)) continue;
      const key = seriesKey(entity.name, signal.name);
      series[key] = withLevel(series[key], asked.level, failed(series[key]?.[asked.level], error));
    }
  }
  return { ...store, series };
}

/* What the plot reads. */

const composed = new WeakMap<Levels, Map<number, SeriesHistory>>();
/** What a series for the plot was made from: while that is the same, its points are the same array. */
const madeFrom = new WeakMap<SeriesHistory, { readonly level: number; readonly rows: readonly (readonly Point[] | undefined)[]; readonly shape: string }>();

/** The rows of `rows` inside the parts of `span` that `taken` does not hold yet. */
function fill(rows: readonly Point[], span: Span, taken: readonly Span[]): readonly Point[] {
  const out: Point[] = [];
  for (const gap of missingSpans(taken, span)) {
    const end = upperBound(rows, gap.to, timeOfPoint);
    for (let i = lowerBound(rows, gap.from, timeOfPoint); i < end; i += 1) out.push(rows[i] as Point);
  }
  return out;
}

/** Where the held spans of each level begin and end, but for the end of the newest one: that moves with every live delta and changes no point. */
function shapeOf(levels: Levels, level: number): string {
  return levels
    .slice(0, level + 1)
    .map((track) => (track?.covered ?? []).map((span, index, all) => (index === all.length - 1 ? `${span.from}` : `${span.from}-${span.to}`)).join(","))
    .join("|");
}

/**
 * A series at one level, as the plot draws it: the track of that level, with the stretches only a finer level holds
 * thinned to the same slots, so the points are evenly dense whatever was read first. The points are the same array
 * as in `previous` (what the plot was given last) while no row changed: the plot keeps its folded lanes by that array.
 */
export function seriesAtLevel(levels: Levels, level: number, previous?: SeriesHistory): SeriesHistory {
  const cache = composed.get(levels) ?? new Map<number, SeriesHistory>();
  composed.set(levels, cache);
  const held = cache.get(level);
  if (held) return held;
  const own = levels[level] ?? null;
  const finer = levels.slice(0, level).filter((track): track is Track<Point> => track !== null && track.covered.length > 0);
  const error = own?.error ?? finer.find((track) => track.error)?.error ?? null;
  const rows = levels.slice(0, level + 1).map((track) => track?.rows);
  const shape = shapeOf(levels, level);
  const before = previous ? madeFrom.get(previous) : undefined;
  const same = before !== undefined && before.level === level && before.shape === shape && before.rows.every((item, index) => item === rows[index]);
  let made: SeriesHistory;
  if (finer.length === 0) made = { points: own?.rows ?? [], covered: own?.covered ?? [], error };
  else {
    let covered = own?.covered ?? [];
    for (const track of finer) for (const span of track.covered) covered = addSpan(covered, span);
    made = { points: same && previous ? previous.points : compose(levels, level), covered, error };
  }
  madeFrom.set(made, { level, rows, shape });
  cache.set(level, made);
  return made;
}

function compose(levels: Levels, level: number): readonly Point[] {
  const own = levels[level] ?? null;
  let covered = own?.covered ?? [];
  const pieces: Point[] = [...(own?.rows ?? [])];
  const slot = (LEVELS[level] as Level).slot;
  for (let l = level - 1; l >= 0; l -= 1) {
    const track = levels[l];
    if (!track) continue;
    for (const span of track.covered) {
      for (const point of decimate(fill(track.rows, span, covered), slot)) pieces.push(point);
      covered = addSpan(covered, span);
    }
  }
  return pieces.sort((a, b) => a[0] - b[0]);
}

/**
 * The level a series is drawn at when `level` is the one the window calls for: that one when it (or a finer one) holds
 * the whole window, else the next coarser one that does, so a zoom shows what is there until the right points arrive.
 */
export function levelToShow(levels: Levels, level: number, window: Span): number {
  for (let l = level; l < LEVELS.length; l += 1) if (covers(coveredAt(levels, l), window)) return l;
  const any = levels.findIndex((track, index) => index > level && track !== null && track.rows.length > 0);
  return (levels[level]?.rows.length ?? 0) > 0 || coveredAt(levels, level).length > 0 || any < 0 ? level : any;
}

const EMPTY_STATES: StateHistory = { transitions: [], covered: [], error: null };
const stateViews = new WeakMap<Track<Transition>, StateHistory>();

function stateView(track: Track<Transition>): StateHistory {
  let view = stateViews.get(track);
  if (!view) {
    view = track.rows.length === 0 && track.covered.length === 0 && track.error === null ? EMPTY_STATES : { transitions: track.rows, covered: track.covered, error: track.error };
    stateViews.set(track, view);
  }
  return view;
}

function flatten<T extends { readonly t: number }>(tracks: Readonly<Record<string, Track<T>>>): readonly T[] {
  const out: T[] = [];
  for (const track of Object.values(tracks)) for (const row of track.rows) out.push(row);
  return out.sort((a, b) => a.t - b.t);
}

function sameValues<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export interface Shown {
  readonly level: number;
  /** The window the plot shows, with its margins: a series is drawn at a level that holds it. */
  readonly window: Span | null;
}

const lastOf = new WeakMap<TimelineData, { readonly store: TimeStore; readonly shown: Shown }>();

/**
 * The store as the plot reads it: one history per entity, one series per signal at the level the window calls for, the
 * annotations and reports of every entity in time order. Whatever did not change keeps its identity, so the plot's
 * caches and React's comparisons hold.
 */
export function toTimelineData(store: TimeStore, shown: Shown, previous: TimelineData): TimelineData {
  const before = lastOf.get(previous);
  if (before && before.store === store && before.shown.level === shown.level && before.shown.window?.from === shown.window?.from && before.shown.window?.to === shown.window?.to) return previous;

  const states: Record<string, StateHistory> = {};
  for (const [name, track] of Object.entries(store.states)) states[name] = stateView(track);
  const series: Record<string, SeriesHistory> = {};
  for (const [key, levels] of Object.entries(store.series)) {
    series[key] = seriesAtLevel(levels, shown.window === null ? shown.level : levelToShow(levels, shown.level, shown.window), previous.series[key]);
  }
  const next: TimelineData = {
    entities: store.entities,
    states: sameValues(states, previous.states) ? previous.states : states,
    series: sameValues(series, previous.series) ? previous.series : series,
    annotations: before && before.store.annotations === store.annotations ? previous.annotations : flatten(store.annotations),
    reports: before && before.store.reports === store.reports ? previous.reports : flatten(store.reports),
    now: store.now,
    floor: store.floor,
  };
  const same = next.entities === previous.entities && next.states === previous.states && next.series === previous.series && next.annotations === previous.annotations && next.reports === previous.reports && next.now === previous.now && next.floor === previous.floor;
  const out = same ? previous : next;
  lastOf.set(out, { store, shown });
  return out;
}

