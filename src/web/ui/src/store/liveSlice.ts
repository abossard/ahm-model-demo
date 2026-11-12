import type { StateCreator } from "zustand";
import { flashEntities } from "../live/flash";
import { announcement, applyDelta, mergeSnapshot, stateChanges, type LiveDelta, type LiveEvent } from "../model/live";
import type { ApiError, HealthModel } from "../model/types";
import { stateCode } from "../model/timelineLive";
import * as api from "./api";
import type { Store } from "./store";
import { liveTimeline } from "./timelineSlice";

/** How the model on screen is kept current: `live` is the stream, `polling` the fallback when the stream is refused. */
export type LiveStatus = "off" | "connecting" | "live" | "reconnecting" | "paused" | "polling";

export const POLL_FALLBACK_MS = 60_000;
/** Longer than any read of the timeline takes. */
export const TIMELINE_HOLD_MS = 120_000;
/** A server clock further than this from the browser's is not a clock difference but old data: it is not followed. */
export const MAX_SKEW_MS = 10 * 60_000;

/** How far the server's clock is from the browser's, when it is a believable distance. */
export function clockSkew(observed: number, now: number): number {
  const skew = observed - now;
  return Number.isFinite(skew) && Math.abs(skew) <= MAX_SKEW_MS ? skew : 0;
}

export interface LiveState {
  readonly liveStatus: LiveStatus;
  readonly liveError: ApiError | null;
  /** When the last event arrived, as the server's clock says. */
  readonly liveEventAt: number | null;
  /** The server's clock minus the browser's, from the last event: how a "now" that follows the server is made. */
  readonly liveSkew: number;
  /** What a screen reader hears when an entity changes state. */
  readonly liveAnnouncement: string;
  /** Entities that changed, with when: the nodes flash and the timeline rows follow. */
  readonly liveChanged: Readonly<Record<string, number>>;
}

export interface LiveActions {
  readonly startLive: () => void;
  readonly stopLive: () => void;
  readonly pauseLive: () => void;
  readonly resumeLive: () => void;
}

let stream: api.ModelStream | null = null;
let poll: number | null = null;
let paused = false;

function stopAll(): void {
  stream?.close();
  stream = null;
  if (poll !== null) window.clearInterval(poll);
  poll = null;
}

export const liveSlice: StateCreator<Store, [], [], LiveState & LiveActions> = (set, get) => {
  const apply = (next: HealthModel, held: HealthModel | null, delta: LiveDelta | null, observed: number): void => {
    const changes = held ? stateChanges(held, next) : [];
    const current = new Map(next.entities.map((entity) => [entity.name, stateCode(entity.healthState)]));
    set((state) => ({
      ...(next !== held ? { model: { kind: "success" as const, value: next } } : {}),
      lastObservedAt: delta?.observedAt ?? next.observedAt,
      refreshError: null,
      liveEventAt: observed,
      liveSkew: clockSkew(observed, Date.now()),
      // While the page shows a past moment a change of now is not what it shows: it is kept, and neither told nor flashed.
      ...(changes.length === 0 || state.timelinePinned !== null
        ? {}
        : {
            liveAnnouncement: announcement(changes),
            liveChanged: { ...state.liveChanged, ...Object.fromEntries(changes.map((change) => [change.name, observed])) },
          }),
      // The timeline's store takes the new rows; a read of the timeline that is on its way gets them applied to its answer.
      ...liveTimeline(state, delta?.timeline, observed, current, TIMELINE_HOLD_MS),
    }));
    if (changes.length > 0 && get().timelinePinned === null) flashEntities(changes.map((change) => change.name));
  };

  const onEvent = (event: LiveEvent): void => {
    const shown = get().model;
    const held = shown.kind === "success" ? shown.value : null;
    if (event.kind === "snapshot") {
      const next = mergeSnapshot(held, event.model);
      if (next !== held || get().liveEventAt === null) apply(next, held, null, Date.parse(next.observedAt));
    } else if (event.kind === "delta") {
      if (held === null) return;
      const next = applyDelta(held, event.delta);
      const observed = Date.parse(event.delta.observedAt ?? held.observedAt);
      if (next !== held || event.delta.timeline || event.delta.observedAt) apply(next, held, event.delta, observed);
    }
  };

  /** The stream ended for good. A busy app (retryable) is read by hand every minute; any other refusal leaves the model as it is. */
  const fallBack = (error: ApiError): void => {
    stream?.close();
    stream = null;
    if (!error.retryable) {
      set({ liveStatus: "off", liveError: error });
      return;
    }
    set({ liveStatus: "polling", liveError: error });
    if (poll === null) poll = window.setInterval(() => void get().loadHealthModel(), POLL_FALLBACK_MS);
  };

  return {
    liveStatus: "off",
    liveError: null,
    liveEventAt: null,
    liveSkew: 0,
    liveAnnouncement: "",
    liveChanged: {},

    startLive: () => {
      stopAll();
      if (paused) {
        set({ liveStatus: "paused" });
        return;
      }
      const { selected } = get();
      if (selected === null) return;
      set({ liveStatus: "connecting", liveError: null, liveEventAt: null });
      stream = api.openModelStream(selected, {
        onEvent,
        onStatus: (status) => {
          if (paused) return;
          set({ liveStatus: status === "open" ? "live" : status });
        },
        onFailure: fallBack,
      });
    },

    stopLive: () => {
      stopAll();
      set({ liveStatus: paused ? "paused" : "off" });
    },

    pauseLive: () => {
      paused = true;
      stopAll();
      set({ liveStatus: "paused" });
    },

    resumeLive: () => {
      paused = false;
      get().startLive();
    },
  };
};

/** Test hook: forgets the connection state that lives outside the store. */
export function resetLive(): void {
  stopAll();
  paused = false;
}
