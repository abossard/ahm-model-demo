import type { StateCreator } from "zustand";
import type { ApiError } from "../model/types";
import {
  EMPTY_TIMELINE,
  mergeResponse,
  seriesKey,
  type TimelineData,
  type TimelineResponse,
} from "../model/timeline";
import type { LiveTimeline } from "../model/live";
import { batchEntities } from "../model/timelineIncidents";
import { applyTimelineDelta, stateCode } from "../model/timelineLive";
import { entityOfKey, rootKeys, type RowOrder } from "../model/timelineRows";
import { DAY, MINUTE, clampView, presetView, type Bounds, type View } from "../model/timelineScale";
import { timelineFromSearch } from "../model/timelineUrl";
import { createIndexedDbCache, type OverviewCache } from "../timeline/overviewCache";
import * as api from "./api";
import type { Store } from "./store";

export const TIMELINE_MIN_HEIGHT = 200;
export const TIMELINE_MAX_HEIGHT = 720;
export const TIMELINE_DEFAULT_HEIGHT = 360;
/** The service reads at most 120 signals in a request; stay under it. */
export const SIGNALS_PER_REQUEST = 100;
const RETENTION = 30 * DAY;
const OVERLAP = 10 * MINUTE;

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
  readonly timelineData: TimelineData;
  readonly timelineStatus: OverviewStatus;
  readonly timelineError: ApiError | null;
  /** Entities whose signals are being read. */
  readonly timelineLoading: readonly string[];
  /** The rows that are open, by key: an open entity shows its signals as lanes, then its dependencies. */
  readonly timelineExpanded: readonly string[];
  readonly timelineOrder: RowOrder;
  /** The instant the model is shown at, set by a click. */
  readonly timelinePinned: number | null;
  /** The window keeps its right edge at now while events and the clock move it. */
  readonly timelineFollow: boolean;
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
  readonly resetTimeline: () => void;
  readonly loadTimelineOverview: () => Promise<void>;
  readonly loadTimelineSignals: (names: readonly string[], from: number, to: number) => Promise<void>;
  readonly refreshTimeline: () => Promise<void>;
  readonly retryTimelineSignals: (names: readonly string[]) => void;
  readonly toggleTimelineEntity: (name: string) => void;
  readonly expandTimelineEntities: (names: readonly string[]) => void;
  readonly collapseTimelineEntities: () => void;
  readonly setTimelineOrder: (order: RowOrder) => void;
  readonly pinTimeline: (t: number | null) => void;
  readonly followTimeline: (follow: boolean) => void;
}

let overviewRequest: AbortController | null = null;
/** The signal requests in flight, with the entities each one reads. */
const signalRequests = new Map<AbortController, readonly string[]>();
let generation = 0;
let overviewCache: OverviewCache | null | undefined;

/** Test hook: replaces the browser cache (null for none). */
export function setOverviewCache(cache: OverviewCache | null): void {
  overviewCache = cache;
}

const cacheKey = (selected: { readonly subscriptionId: string; readonly resourceGroup: string; readonly name: string } | null): string =>
  selected ? `${selected.subscriptionId}/${selected.resourceGroup}/${selected.name}`.toLowerCase() : "";

/** Cancels every request the timeline has in flight: the model it was made for is gone. */
export function cancelTimelineSignals(): void {
  for (const request of signalRequests.keys()) request.abort();
  signalRequests.clear();
}

/** Cancels the requests none of whose entities shows any more; one that reads an entity still shown is left to finish. */
export function cancelUnwantedSignals(wanted: ReadonlySet<string>): void {
  for (const [request, names] of signalRequests) {
    if (names.some((name) => wanted.has(name))) continue;
    request.abort();
    signalRequests.delete(request);
  }
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

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asApiError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) return error as ApiError;
  return { code: "unknown", message: error instanceof Error ? error.message : "The timeline could not be loaded.", retryable: true, operationId: null };
}

const without = (list: readonly string[], names: readonly string[]): readonly string[] => list.filter((name) => !names.includes(name));

/** The first time a model's rows are known they open to the roots; after that the viewer's choice stands. */
const firstOpen = (state: TimelineState, next: TimelineData): readonly string[] =>
  state.timelineData.entities.length === 0 && state.timelineExpanded.length === 0 ? rootKeys(next.entities) : state.timelineExpanded;

export const timelineSlice: StateCreator<Store, [], [], TimelineState & TimelineActions> = (set, get) => {
  /** A request that failed as a whole fails every series it asked for, so none is asked again until retried. */
  const markFailed = (names: readonly string[], error: ApiError): void => {
    const failure = { code: error.code, message: error.message, retryable: error.retryable };
    set((state) => {
      const series = { ...state.timelineData.series };
      for (const entity of state.timelineData.entities) {
        if (!names.includes(entity.name)) continue;
        for (const signal of entity.signals) {
          const key = seriesKey(entity.name, signal.name);
          series[key] = { points: series[key]?.points ?? [], covered: series[key]?.covered ?? [], error: failure };
        }
      }
      return { timelineData: { ...state.timelineData, series }, timelineError: error };
    });
  };

  return {
  timelineOpen: false,
  timelineFullscreen: false,
  timelineFocus: null,
  timelineHeight: TIMELINE_DEFAULT_HEIGHT,
  timelineView: null,
  timelineData: EMPTY_TIMELINE,
  timelineStatus: "idle",
  timelineError: null,
  timelineLoading: [],
  timelineExpanded: [],
  timelineOrder: "structure",
  timelinePinned: null,
  timelineFollow: true,
  timelineStale: false,
  timelineHeld: [],

  openTimeline: () => set({ timelineOpen: true }),
  closeTimeline: () => {
    cancelTimelineSignals();
    set({ timelineOpen: false, timelineFullscreen: false, timelineFocus: null });
  },
  toggleTimeline: () => (get().timelineOpen ? get().closeTimeline() : get().openTimeline()),
  setTimelineFullscreen: (timelineFullscreen) => set({ timelineFullscreen }),
  showInTimeline: (name, key = null) => set((state) => ({ timelineOpen: true, timelineFocus: { name, key, seq: (state.timelineFocus?.seq ?? 0) + 1 } })),

  initializeTimeline: (search) => {
    const link = timelineFromSearch(search);
    if (!link.open) return;
    const now = Date.now();
    set({
      timelineOpen: true,
      timelineFullscreen: link.fullscreen,
      timelineFollow: link.follow || link.view === null,
      timelineView: link.follow && link.span !== null ? { t0: now - link.span, t1: now } : link.view,
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
    set((state) => ({ timelineView: next, timelineFollow: state.timelineFollow && atNow }));
  },

  resetTimeline: () => {
    generation += 1;
    overviewRequest?.abort();
    overviewRequest = null;
    cancelTimelineSignals();
    set({
      timelineData: EMPTY_TIMELINE,
      timelineStatus: "idle",
      timelineError: null,
      timelineLoading: [],
      timelineExpanded: [],
      timelinePinned: null,
      timelineStale: false,
      timelineHeld: [],
    });
  },

  loadTimelineOverview: async () => {
    const { selected } = get();
    const mine = generation;
    overviewRequest?.abort();
    const request = new AbortController();
    overviewRequest = request;
    set((state) => ({ timelineStatus: state.timelineStatus === "ready" ? "ready" : "loading", timelineError: null }));
    const now = Date.now();
    const key = cacheKey(selected);
    overviewCache ??= createIndexedDbCache();
    let hydratedView: View | null = null;
    if (get().timelineStatus !== "ready" && overviewCache && key !== "") {
      // Paint what the browser kept at once; the network answer replaces it.
      void overviewCache.read(key).then((cached) => {
        if (!cached || mine !== generation || get().timelineStatus === "ready" || get().selected !== selected) return;
        const data = mergeResponse(get().timelineData, cached);
        const bounds = timelineBounds(data, now);
        hydratedView = get().timelineView ?? presetView("24h", bounds);
        set((state) => ({ timelineData: data, timelineExpanded: firstOpen(state, data), timelineStatus: "ready", timelineStale: true, timelineView: hydratedView }));
      });
    }
    let response: TimelineResponse;
    try {
      response = await api.fetchTimeline(selected, { from: now - RETENTION, to: now, include: ["states", "annotations", "reports"] }, request.signal);
    } catch (error) {
      if (isAbort(error) || mine !== generation) return;
      set((state) => (state.timelineStatus === "ready" ? { timelineError: asApiError(error) } : { timelineStatus: "failed", timelineError: asApiError(error) }));
      return;
    }
    if (mine !== generation || get().selected !== selected) return;
    const stale = get().timelineStale;
    const answered = mergeResponse(stale ? { ...get().timelineData, states: {}, series: {} } : get().timelineData, response);
    const shown = get().model;
    const current = new Map((shown.kind === "success" ? shown.value.entities : []).map((entity) => [entity.name, stateCode(entity.healthState)]));
    const data = get().timelineHeld.reduce((held, item) => applyTimelineDelta(held, item.timeline, item.observed, current), answered);
    const view = get().timelineView;
    const bounds = timelineBounds(data, now);
    // A view that came from the cache ends where the cache did: begin again from now.
    const rebase = stale && view !== null && hydratedView !== null && view === hydratedView ? presetView("24h", bounds) : view;
    set((state) => ({
      timelineData: data,
      timelineExpanded: firstOpen(state, data),
      timelineStatus: "ready",
      timelineStale: false,
      timelineError: null,
      timelineView: rebase ? clampView(rebase, bounds) : presetView("24h", bounds),
    }));
    overviewCache?.write(key, response);
  },

  loadTimelineSignals: async (names, from, to) => {
    const { selected, timelineData } = get();
    const mine = generation;
    const request = new AbortController();
    signalRequests.set(request, names);
    set((state) => ({ timelineLoading: [...new Set([...state.timelineLoading, ...names])] }));
    const settled = (): void => {
      signalRequests.delete(request);
      if (mine === generation) set((state) => ({ timelineLoading: without(state.timelineLoading, names) }));
    };
    try {
      for (const batch of batchEntities(timelineData, names, SIGNALS_PER_REQUEST)) {
        const response = await api.fetchTimeline(selected, { from, to, include: ["signals"], entities: batch }, request.signal);
        if (mine !== generation || get().selected !== selected) return;
        set((state) => ({ timelineData: mergeResponse(state.timelineData, response) }));
      }
    } catch (error) {
      if (isAbort(error) || mine !== generation) return;
      markFailed(names, asApiError(error));
    } finally {
      settled();
    }
  },

  refreshTimeline: async () => {
    // A timeline that is closed holds nothing worth reading again: it is read afresh when it opens.
    if (!get().timelineOpen) return;
    await get().loadTimelineOverview();
    const { timelineExpanded, timelineData } = get();
    const withSignals = new Set(timelineData.entities.filter((entity) => entity.signals.length > 0).map((entity) => entity.name));
    const names = [...new Set(timelineExpanded.map(entityOfKey))].filter((name) => withSignals.has(name));
    if (names.length === 0) return;
    const now = Date.now();
    await get().loadTimelineSignals(names, Math.max(timelineData.floor, timelineData.now - OVERLAP), now);
  },

  retryTimelineSignals: (names) =>
    set((state) => {
      const series = { ...state.timelineData.series };
      for (const entity of state.timelineData.entities) {
        if (!names.includes(entity.name)) continue;
        for (const signal of entity.signals) {
          const held = series[seriesKey(entity.name, signal.name)];
          if (held?.error) series[seriesKey(entity.name, signal.name)] = { ...held, error: null };
        }
      }
      return { timelineData: { ...state.timelineData, series } };
    }),

  toggleTimelineEntity: (name) =>
    set((state) => ({
      timelineExpanded: state.timelineExpanded.includes(name) ? without(state.timelineExpanded, [name]) : [...state.timelineExpanded, name],
    })),
  expandTimelineEntities: (names) =>
    set((state) => ({ timelineExpanded: [...new Set([...state.timelineExpanded, ...names])] })),
  collapseTimelineEntities: () => set({ timelineExpanded: [] }),
  setTimelineOrder: (order) => set({ timelineOrder: order }),
  pinTimeline: (t) => set({ timelinePinned: t }),
  followTimeline: (follow) => {
    const { timelineView, timelineData } = get();
    if (!follow || timelineView === null) {
      set({ timelineFollow: follow });
      return;
    }
    const hi = timelineBounds(timelineData, Date.now()).hi;
    set({ timelineFollow: true, timelineView: { t0: hi - (timelineView.t1 - timelineView.t0), t1: hi } });
  },
};
};
