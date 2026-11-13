import type { StateCreator } from "zustand";
import type { ApiError, Entity, HealthModel, HealthState } from "../model/types";
import { EMPTY_TIMELINE, seriesKey, type EntityInfo, type Point, type SignalInfo, type Span, type TimelineData } from "../model/timeline";
import type { LiveTimeline } from "../model/live";
import { applyLive, stateCode } from "../model/timelineLive";
import { REPORT_SIGNAL, SPARK_LEVEL, SPARK_SPAN, sparkWindow, type Demand, type EntityHint, type TileRequest } from "../model/timelinePlan";
import { rootKeys, type RowOrder } from "../model/timelineRows";
import { DAY, MINUTE, clampView, presetView, type Bounds, type View } from "../model/timelineScale";
import { LEVELS, RAW, levelFor, type Level } from "../model/timelineTiles";
import { entityOf, lastChangeAt, modelAt } from "../model/timeTravel";
import { EMPTY_STORE, clearErrors, markFailed, seriesAtLevel, toTimelineData, type Levels, type Shown, type TimeStore } from "../model/timeStore";
import { timelineFromSearch } from "../model/timelineUrl";
import { createTileCache, indexedDbStorage, type CacheScope, type TileCache } from "../timeline/tileCache";
import { createTimelineLoader, type TimelineLoader } from "../timeline/timelineLoader";
import * as api from "./api";
import type { State, Store } from "./store";

export const TIMELINE_MIN_HEIGHT = 200;
export const TIMELINE_MAX_HEIGHT = 720;
export const TIMELINE_DEFAULT_HEIGHT = 360;

export type OverviewStatus = "idle" | "loading" | "ready" | "failed";

/** An entity to bring into view in the timeline. `seq` tells two requests for the same entity apart. */
export interface TimelineFocus {
  readonly name: string;
  /** The row the viewer clicked, when the entity has several. */
  readonly key: string | null;
  readonly seq: number;
}

export interface TimelineState {
  readonly timelineOpen: boolean;
  /** The timeline fills the window below the top bar. */
  readonly timelineFullscreen: boolean;
  /** The entity the timeline brings into view: its row is selected, opened and scrolled to. */
  readonly timelineFocus: TimelineFocus | null;
  readonly timelineHeight: number;
  /** The window on screen, committed when a gesture settles. Null until the history is known. */
  readonly timelineView: View | null;
  /**
   * Everything held about the model over time, keyed by what it is: the one place timeline data lives. The loader
   * fills it, the live stream adds to it, and every view reads it through a selector.
   */
  readonly timelineSeries: TimeStore;
  /** The level and window the plot is drawn at: what `timelineData` is made for. */
  readonly timelineShown: Shown;
  /** `timelineSeries` as the plot reads it. Derived in the same step as every change of the store: never set on its own. */
  readonly timelineData: TimelineData;
  readonly timelineStatus: OverviewStatus;
  readonly timelineError: ApiError | null;
  /** Entities whose signals are being read. */
  readonly timelineLoading: readonly string[];
  /** The rows that are open, by key: an open entity shows its signals as lanes, then its dependencies. */
  readonly timelineExpanded: readonly string[];
  readonly timelineOrder: RowOrder;
  /**
   * The selected moment: the one clock of the page. Null is now, and live. Every view that shows the model at a moment
   * reads it (`selectedMoment`, `selectModelAt`); a click in the timeline sets it.
   */
  readonly timelinePinned: number | null;
  /** The entities whose signal values other views show at the selected moment: their series are read around it. */
  readonly timelineWatched: readonly string[];
  /** The entities whose cards on the graph show sparklines: their series are read for the window that ends at the moment. */
  readonly timelineSparks: readonly string[];
  /** The window keeps its right edge at now while events and the clock move it. */
  readonly timelineFollow: boolean;
  /** The window followed now when a moment was selected: it follows again when the selection is cleared. */
  readonly timelineFollowPaused: boolean;
  /** What is shown was read from the browser's cache and the network has not answered yet. */
  readonly timelineStale: boolean;
  /** The live changes of the last minutes: they are applied to every answer of the network, which may not have them. */
  readonly timelineHeld: readonly HeldTimeline[];
}

export interface HeldTimeline {
  readonly timeline: LiveTimeline;
  readonly observed: number;
}

export interface TimelineActions {
  readonly openTimeline: () => void;
  readonly closeTimeline: () => void;
  readonly toggleTimeline: () => void;
  readonly setTimelineFullscreen: (fullscreen: boolean) => void;
  /** Opens the timeline if it is closed and brings an entity into view in it; `key` is the row when it has several. */
  readonly showInTimeline: (name: string, key?: string | null) => void;
  readonly initializeTimeline: (search: string) => void;
  readonly setTimelineHeight: (height: number) => void;
  readonly setTimelineView: (view: View) => void;
  /**
   * Forgets what is held and begins again for the selected model and user. The selected moment goes with it, unless
   * `keepMoment` and the timeline is set up again for the model and user it was set up for, or for the first time: the
   * first set-up of a page keeps the moment its link named.
   */
  readonly resetTimeline: (keepMoment?: boolean) => void;
  /** What the timeline shows now: the loader reads what is missing of it. */
  readonly wantTimeline: (demand: Demand) => void;
  /** Asks again for everything that failed. Resolves when nothing is being read. */
  readonly loadTimelineOverview: () => Promise<void>;
  /** Reads the tiles that are still open again. Resolves when nothing is being read. */
  readonly refreshTimeline: () => Promise<void>;
  readonly retryTimelineSignals: (names: readonly string[]) => void;
  readonly toggleTimelineEntity: (name: string) => void;
  readonly expandTimelineEntities: (names: readonly string[]) => void;
  readonly collapseTimelineEntities: () => void;
  readonly setTimelineOrder: (order: RowOrder) => void;
  /** Selects a moment, or now with null. The same as `selectMoment`: the name the timeline's own controls use. */
  readonly pinTimeline: (t: number | null) => void;
  /** Selects the moment the whole page shows, or now with null. */
  readonly selectMoment: (t: number | null) => void;
  /** Names the entities whose signal values are shown at the selected moment outside the timeline's lanes. */
  readonly watchEntities: (names: readonly string[]) => void;
  /** Names the entities whose cards show sparklines. */
  readonly watchSparks: (names: readonly string[]) => void;
  /**
   * While the timeline is closed: reads the series of the sparklines `timelineSparks` names, and the structure that says
   * which signals there are, nothing else. The timeline is set up for the selected model and user first if it is not.
   */
  readonly wantSparks: () => void;
  readonly followTimeline: (follow: boolean) => void;
}

let loader: TimelineLoader | null = null;
let cache: TileCache | null | undefined;
/** The view that was made from what the browser kept: it ends where the cache did, so the first answer moves it to now. */
let hydratedView: View | null = null;
/**
 * The model the loader was opened for, taken with the scope its answers are kept under: every request asks for it, so
 * an answer is never kept under another model's scope while the selection changes.
 */
let openedSelection: State["selected"] = null;
/** The model and user the timeline was last set up for, null before the first set-up: the selected moment belongs to them. */
let setUpFor: string | null = null;

/** Test hook: replaces the browser's cache (null for none). */
export function setTimelineCache(next: TileCache | null): void {
  cache = next;
}

function cacheOf(): TileCache | null {
  if (cache === undefined) {
    const storage = indexedDbStorage();
    cache = storage ? createTileCache(storage) : null;
  }
  return cache;
}

const modelKey = (selected: { readonly subscriptionId: string; readonly resourceGroup: string; readonly name: string } | null): string =>
  selected ? `${selected.subscriptionId}/${selected.resourceGroup}/${selected.name}`.toLowerCase() : "";

/** The model and user a timeline is set up for, in words. */
const setUpKey = (scope: CacheScope): string => `${scope.owner}\u0001${scope.model}`;

/** Whose cache it is: the signed-in user in their directory, or the one local user of a development server. */
export function cacheScope(state: Pick<State, "account" | "selected">): CacheScope | null {
  if (state.selected === null) return null;
  return { owner: state.account ? `${state.account.tenantId}/${state.account.username}` : "local", model: modelKey(state.selected) };
}

/** Cancels every request the timeline has in flight: it closed, or the model it was made for is gone. */
export function cancelTimelineSignals(): void {
  loader?.stop();
}

/** Resolves when the timeline reads nothing, from the browser's cache or the app. */
export function timelineIdle(): Promise<void> {
  return loader?.idle() ?? Promise.resolve();
}

/** The selected moment, null for now: the one clock every view reads. */
export const selectedMoment = (state: Pick<State, "timelinePinned">): number | null => state.timelinePinned;

/**
 * The health model as the views take it, at the selected moment: the live model itself while none is selected, and
 * null until a model is loaded. Entities that did not change between two moments keep their identity.
 */
export function selectModelAt(state: Pick<State, "model" | "timelineSeries" | "timelinePinned">): HealthModel | null {
  return state.model.kind === "success" ? modelAt(state.model.value, state.timelineSeries, state.timelinePinned) : null;
}

/** The minute the selected moment is in, null for now: what a sentence that names the moment needs, and no more often than it changes. */
export const selectMomentMinute = (state: Pick<State, "timelinePinned">): number | null => (state.timelinePinned === null ? null : Math.floor(state.timelinePinned / MINUTE) * MINUTE);

/** The state the model had at the selected moment: its own while none is selected, null until it is loaded. */
export const selectModelState = (state: Pick<State, "model" | "timelineSeries" | "timelinePinned">): HealthState | null => selectModelAt(state)?.model.healthState ?? null;

/** The selected entity as it was at the selected moment, undefined while none is selected or the model does not have it. */
export function selectEntityAt(state: Pick<State, "model" | "timelineSeries" | "timelinePinned" | "selectedName">): Entity | undefined {
  return entityOf(selectModelAt(state), state.selectedName);
}

/**
 * When the selected entity last changed its state, as an ISO time, null when nothing says. Now it is the newest change
 * its detail lists; at a selected moment it is the last change at or before the moment that the history held has.
 */
export function selectLastChange(state: Pick<State, "selectedName" | "detail" | "timelineSeries" | "timelinePinned">): string | null {
  const { selectedName, detail, timelinePinned } = state;
  if (selectedName === null) return null;
  if (timelinePinned !== null) {
    const at = lastChangeAt(state.timelineSeries.states[selectedName], timelinePinned);
    return at === null ? null : new Date(at).toISOString();
  }
  if (detail.kind !== "success" || detail.value.entity.name !== selectedName) return null;
  let newest: string | null = null;
  for (const { occurredAt } of detail.value.transitions) {
    if (occurredAt !== null && !Number.isNaN(Date.parse(occurredAt)) && (newest === null || Date.parse(occurredAt) > Date.parse(newest))) newest = occurredAt;
  }
  return newest;
}

/** A sparkline: the points held for its window at the sparkline's level, and the signal with its rules. */
export interface SparkLine {
  readonly points: readonly Point[];
  readonly info: SignalInfo | undefined;
}

/** What the sparklines of one card show: the window, which ends at the selected moment or at the newest minute held, and a line by signal. */
export interface CardSparks {
  readonly window: Span;
  readonly lines: ReadonlyMap<string, SparkLine>;
}

const entityIndex = new WeakMap<readonly EntityInfo[], ReadonlyMap<string, EntityInfo>>();

function entityInfo(entities: readonly EntityInfo[], name: string): EntityInfo | undefined {
  let index = entityIndex.get(entities);
  if (!index) {
    index = new Map(entities.map((entity) => [entity.name, entity]));
    entityIndex.set(entities, index);
  }
  return index.get(name);
}

/**
 * Makes the selector of one entity's sparklines, for `useAtMoment`; make it once per entity. It gives the same object
 * while the window and what is held of the entity's signals stay the same, so a card draws again only when its own lines
 * change, not on every change of the store.
 */
export function selectSparksOf(entity: string): (state: Pick<State, "timelineSeries" | "timelinePinned">) => CardSparks {
  let last: CardSparks | null = null;
  let heldInfo: EntityInfo | undefined;
  let heldLevels: readonly (Levels | undefined)[] = [];
  return (state) => {
    const store = state.timelineSeries;
    const info = entityInfo(store.entities, entity);
    const end = state.timelinePinned ?? Math.floor(store.now / MINUTE) * MINUTE;
    const levels = (info?.signals ?? []).map((signal) => store.series[seriesKey(entity, signal.name)]);
    if (last !== null && info === heldInfo && last.window.to === end && levels.length === heldLevels.length && levels.every((item, index) => item === heldLevels[index])) return last;
    const lines = new Map<string, SparkLine>();
    for (const [index, signal] of (info?.signals ?? []).entries()) {
      const held = levels[index];
      lines.set(signal.name, { points: held ? seriesAtLevel(held, SPARK_LEVEL).points : [], info: signal });
    }
    heldInfo = info;
    heldLevels = levels;
    last = { window: { from: end - SPARK_SPAN, to: end }, lines };
    return last;
  };
}

/** The oldest instant any entity's history starts at: the real beginning of "all". */
export function historyStart(data: TimelineData): number {
  let start = Number.POSITIVE_INFINITY;
  for (const history of Object.values(data.states)) {
    const first = history.transitions[0];
    if (first) start = Math.min(start, first.t);
  }
  return Number.isFinite(start) ? Math.max(data.floor, start - 5 * MINUTE) : data.floor;
}

/** What a view may show: from where the history starts to the newest instant the service has answered for. */
export function timelineBounds(data: TimelineData, now: number): Bounds {
  if (data.now === 0) return { lo: now - DAY, hi: now };
  return { lo: Math.min(historyStart(data), data.now - DAY), hi: data.now };
}

const without = (list: readonly string[], names: readonly string[]): readonly string[] => list.filter((name) => !names.includes(name));

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/** The first time a model's rows are known they open to the roots; after that the viewer's choice stands. */
const firstOpen = (state: TimelineState, next: TimelineData): readonly string[] =>
  state.timelineData.entities.length === 0 && state.timelineExpanded.length === 0 ? rootKeys(next.entities) : state.timelineExpanded;

/** The store and what the plot reads of it, changed together. */
function held(state: Pick<TimelineState, "timelineData" | "timelineShown">, series: TimeStore, shown: Shown = state.timelineShown): Pick<TimelineState, "timelineSeries" | "timelineShown" | "timelineData"> {
  return { timelineSeries: series, timelineShown: shown, timelineData: toTimelineData(series, shown, state.timelineData) };
}

const currentStates = (state: Pick<State, "model">): ReadonlyMap<string, ReturnType<typeof stateCode>> =>
  new Map((state.model.kind === "success" ? state.model.value.entities : []).map((entity) => [entity.name, stateCode(entity.healthState)]));

/**
 * What a live delta changes in the timeline: its rows go onto what is held, and it is kept for a while, because an
 * answer of the app that is on its way may not have it yet.
 */
export function liveTimeline(state: State, delta: LiveTimeline | undefined, observed: number, current: ReadonlyMap<string, ReturnType<typeof stateCode>>, holdMs: number): Partial<TimelineState> {
  return {
    ...(state.timelineStatus === "ready" ? held(state, applyLive(state.timelineSeries, delta, observed, current)) : {}),
    ...(delta ? { timelineHeld: [...state.timelineHeld.filter((item) => item.observed > observed - holdMs), { timeline: delta, observed }] } : {}),
  };
}

export const timelineSlice: StateCreator<Store, [], [], TimelineState & TimelineActions> = (set, get) => {
  const hint = (): readonly EntityHint[] | null => {
    const shown = get().model;
    if (shown.kind !== "success") return null;
    return shown.value.entities.map((entity) => ({ name: entity.name, reports: entity.signals.some((signal) => signal.name === REPORT_SIGNAL) }));
  };

  /** An answer of the app or tiles from the browser's cache: into the store, and the first one makes the timeline ready. */
  const merge = (change: (store: TimeStore) => TimeStore, source: "cache" | "network", request: TileRequest | null): void => {
    set((state) => {
      const changed = change(state.timelineSeries);
      // The live changes of the last minutes are applied again: an answer that was read before them does not have them.
      const series = source === "network" ? state.timelineHeld.reduce((store, item) => applyLive(store, item.timeline, item.observed, currentStates(state)), changed) : changed;
      const next = held(state, series);
      if (series.entities.length === 0) return next;
      const first = state.timelineStatus !== "ready";
      const answered = source === "network" && request !== null && !request.parts.includes("signals");
      const bounds = timelineBounds(next.timelineData, Date.now());
      let view = state.timelineView;
      if (view === null) {
        view = presetView("24h", bounds);
        hydratedView = source === "cache" ? view : null;
      } else if (answered && state.timelineStale && view === hydratedView) {
        // A view that came from the cache ends where the cache did: begin again from now.
        view = presetView("24h", bounds);
        hydratedView = null;
      }
      return {
        ...next,
        timelineStatus: "ready",
        timelineExpanded: firstOpen(state, next.timelineData),
        timelineView: view,
        timelineStale: first ? source === "cache" : state.timelineStale && !answered,
        ...(answered ? { timelineError: null } : {}),
      };
    });
  };

  const loaderOf = (): TimelineLoader => {
    loader ??= createTimelineLoader({
      fetch: (request, signal) =>
        api.fetchTimeline(
          openedSelection,
          {
            from: request.from,
            to: request.to,
            include: request.parts,
            entities: request.entities,
            signals: request.signals,
            resolution: request.parts.includes("signals") ? (LEVELS[request.level] as Level).slot / 1000 : 0,
          },
          signal,
        ),
      cache: cacheOf,
      held: () => get().timelineSeries,
      merge,
      failed: (request, error) =>
        set((state) => ({
          ...held(state, markFailed(state.timelineSeries, request, { code: error.code, message: error.message, retryable: error.retryable })),
          timelineError: error,
          ...(state.timelineStatus === "ready" ? {} : { timelineStatus: "failed" as const }),
        })),
      reading: (entities, overview) => {
        const state = get();
        const status = overview && state.timelineStatus === "idle" ? "loading" : state.timelineStatus;
        if (!sameList(entities, state.timelineLoading) || status !== state.timelineStatus) set({ timelineLoading: entities, timelineStatus: status });
      },
      hint,
      now: () => Date.now(),
    });
    return loader;
  };

  return {
  timelineOpen: false,
  timelineFullscreen: false,
  timelineFocus: null,
  timelineHeight: TIMELINE_DEFAULT_HEIGHT,
  timelineView: null,
  timelineSeries: EMPTY_STORE,
  timelineShown: { level: RAW, window: null },
  timelineData: EMPTY_TIMELINE,
  timelineStatus: "idle",
  timelineError: null,
  timelineLoading: [],
  timelineExpanded: [],
  timelineOrder: "structure",
  timelinePinned: null,
  timelineWatched: [],
  timelineSparks: [],
  timelineFollow: true,
  timelineFollowPaused: false,
  timelineStale: false,
  timelineHeld: [],

  openTimeline: () => set({ timelineOpen: true }),
  closeTimeline: () => {
    cancelTimelineSignals();
    // The selected moment is set and cleared in the timeline: closing it returns the page to now.
    get().selectMoment(null);
    set({ timelineOpen: false, timelineFullscreen: false, timelineFocus: null });
  },
  toggleTimeline: () => (get().timelineOpen ? get().closeTimeline() : get().openTimeline()),
  setTimelineFullscreen: (timelineFullscreen) => set({ timelineFullscreen }),
  showInTimeline: (name, key = null) => set((state) => ({ timelineOpen: true, timelineFocus: { name, key, seq: (state.timelineFocus?.seq ?? 0) + 1 } })),

  initializeTimeline: (search) => {
    const now = Date.now();
    const link = timelineFromSearch(search, now);
    if (!link.open) return;
    const following = link.follow || link.view === null;
    set({
      timelineOpen: true,
      timelineFullscreen: link.fullscreen,
      // A link at a past moment does not follow now: it will again, if it did, once the page returns to now.
      timelineFollow: following && link.at === null,
      timelineFollowPaused: following && link.at !== null,
      timelineView: link.follow && link.span !== null ? { t0: now - link.span, t1: now } : link.view,
      timelinePinned: link.at,
    });
  },

  setTimelineHeight: (height) =>
    set({ timelineHeight: Math.min(TIMELINE_MAX_HEIGHT, Math.max(TIMELINE_MIN_HEIGHT, Math.round(height))) }),

  setTimelineView: (view) => {
    const { timelineData, timelineView } = get();
    const bounds = timelineBounds(timelineData, Date.now());
    const next = timelineData.now > 0 ? clampView(view, bounds) : view;
    if (timelineView && timelineView.t0 === next.t0 && timelineView.t1 === next.t1) return;
    // A window that no longer ends at now is no longer followed: the viewer moved away on purpose.
    const atNow = next.t1 >= bounds.hi - Math.max(30_000, (next.t1 - next.t0) * 0.02);
    set((state) => ({ timelineView: next, timelineFollow: state.timelineFollow && atNow, timelineFollowPaused: state.timelineFollowPaused && atNow }));
  },

  resetTimeline: (keepMoment = false) => {
    hydratedView = null;
    const opening = get();
    const scope = cacheScope(opening);
    const key = scope === null ? "" : setUpKey(scope);
    // A moment picked on one model, or by one user, is never carried to another, however the timeline is set up again.
    const keep = keepMoment && (setUpFor === null || setUpFor === key);
    setUpFor = key;
    openedSelection = opening.selected;
    set((state) => ({
      timelineSeries: EMPTY_STORE,
      timelineData: EMPTY_TIMELINE,
      timelineStatus: "idle",
      timelineError: null,
      timelineLoading: [],
      timelineExpanded: [],
      timelinePinned: keep ? state.timelinePinned : null,
      timelineFollowPaused: keep && state.timelinePinned !== null && state.timelineFollowPaused,
      timelineStale: false,
      timelineHeld: [],
    }));
    loaderOf().open(scope);
  },

  wantTimeline: (demand) => {
    const shown: Shown = { level: levelFor(demand.view.to - demand.view.from, demand.width), window: demand.view };
    const state = get();
    if (shown.level !== state.timelineShown.level || shown.window?.from !== state.timelineShown.window?.from || shown.window?.to !== state.timelineShown.window?.to) {
      set(held(state, state.timelineSeries, shown));
    }
    loaderOf().want(demand);
  },

  loadTimelineOverview: () => {
    set((state) => ({ ...held(state, clearErrors(state.timelineSeries, null)), timelineError: null, ...(state.timelineStatus === "failed" ? { timelineStatus: "loading" as const } : {}) }));
    loaderOf().retry();
    return loaderOf().idle();
  },

  refreshTimeline: () => {
    // A timeline that is closed holds nothing worth reading again: it is read afresh when it opens.
    if (!get().timelineOpen) return Promise.resolve();
    // A history that was busy or late the last time is tried again with the rest.
    set((state) => held(state, clearErrors(state.timelineSeries, null, true)));
    loaderOf().refresh();
    return loaderOf().idle();
  },

  retryTimelineSignals: (names) => {
    set((state) => held(state, clearErrors(state.timelineSeries, names)));
    loaderOf().retry();
  },

  toggleTimelineEntity: (name) =>
    set((state) => ({
      timelineExpanded: state.timelineExpanded.includes(name) ? without(state.timelineExpanded, [name]) : [...state.timelineExpanded, name],
    })),
  expandTimelineEntities: (names) =>
    set((state) => ({ timelineExpanded: [...new Set([...state.timelineExpanded, ...names])] })),
  collapseTimelineEntities: () => set({ timelineExpanded: [] }),
  setTimelineOrder: (order) => set({ timelineOrder: order }),
  pinTimeline: (t) => get().selectMoment(t),
  selectMoment: (t) => {
    const { timelinePinned, timelineFollow, timelineView, timelineData } = get();
    if (t === timelinePinned) return;
    // A comparison is of a proposal against the model now: the page leaves it when it leaves now.
    if (t !== null && get().compare) {
      get().setCompare(false);
      get().announce("The comparison is closed: it is about the model now, and the page shows a past moment.");
    }
    if (t === null) {
      const resume = get().timelineFollowPaused;
      set({ timelinePinned: null, timelineFollowPaused: false });
      if (resume) get().followTimeline(true);
      return;
    }
    if (!timelineFollow) {
      set({ timelinePinned: t });
      return;
    }
    // While a moment is selected nothing on screen moves: the window stops where it follows now, and remembers that it followed.
    const hi = timelineBounds(timelineData, Date.now()).hi;
    set({
      timelinePinned: t,
      timelineFollow: false,
      timelineFollowPaused: true,
      ...(timelineView === null ? {} : { timelineView: { t0: hi - (timelineView.t1 - timelineView.t0), t1: hi } }),
    });
  },
  watchEntities: (names) => {
    if (!sameList(names, get().timelineWatched)) set({ timelineWatched: names });
  },
  watchSparks: (names) => {
    if (!sameList(names, get().timelineSparks)) set({ timelineSparks: names });
  },
  wantSparks: () => {
    const scope = cacheScope(get());
    if (scope === null) return;
    if (setUpFor !== setUpKey(scope)) get().resetTimeline(true);
    const now = Date.now();
    loaderOf().want({ view: sparkWindow(now, now), width: 1, lanes: [], moment: null, watched: [], sparks: get().timelineSparks, overview: false });
  },
  followTimeline: (follow) => {
    const { timelineView, timelineData } = get();
    if (!follow || timelineView === null) {
      set({ timelineFollow: follow, timelineFollowPaused: false });
      return;
    }
    const hi = timelineBounds(timelineData, Date.now()).hi;
    set({ timelineFollow: true, timelineFollowPaused: false, timelineView: { t0: hi - (timelineView.t1 - timelineView.t0), t1: hi } });
  },
};
};
