import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../model/live";
import { EMPTY_TIMELINE, mergeResponse, type TimelineResponse } from "../model/timeline";
import type { ApiError, Entity, HealthModel, ModelRef } from "../model/types";
import * as api from "./api";
import { POLL_FALLBACK_MS, clockSkew, resetLive } from "./liveSlice";
import { actions, useStore } from "./store";
import * as flash from "../live/flash";

vi.mock("./api");
vi.mock("../live/flash", () => ({ flashEntities: vi.fn() }));

const MODEL_REF: ModelRef = { id: "/a", name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a", location: null, provisioningState: null };

function entity(name: string, state: Entity["healthState"] = "Healthy"): Entity {
  return {
    name,
    displayName: name === "ss" ? "Session Storage" : name,
    healthState: state,
    impact: "Standard",
    canvasPosition: null,
    discoveredBy: null,
    parents: [],
    children: [],
    unlinked: false,
    latestEvaluationAt: null,
    latestTransitionAt: null,
    signals: [],
    report: { eligible: true, signalName: null },
  };
}

const MODEL: HealthModel = {
  model: { id: null, name: "hm-a", location: null, provisioningState: null, healthState: "Healthy" },
  observedAt: "2026-11-11T10:00:00.000Z",
  entities: [entity("root"), entity("ss"), entity("api")],
  relationships: [{ name: "r1", displayName: null, parentEntityName: "root", childEntityName: "ss" }],
  reportOptions: { signalName: "s", healthStates: [], values: [], expiries: [], reasonPresets: [] },
};

interface Fake {
  readonly handlers: api.ModelStreamHandlers;
  closed: boolean;
}
const streams: Fake[] = [];

function emit(event: LiveEvent, index = streams.length - 1): void {
  streams[index]?.handlers.onEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  streams.length = 0;
  resetLive();
  vi.resetAllMocks();
  vi.mocked(api.openModelStream).mockImplementation((_selection, handlers) => {
    const fake: Fake = { handlers, closed: false };
    streams.push(fake);
    return { close: () => (fake.closed = true) };
  });
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ selected: MODEL_REF, model: { kind: "success", value: MODEL } });
});

afterEach(() => {
  resetLive();
  vi.useRealTimers();
});

describe("starting and stopping", () => {
  it("opens one stream for the selected model and follows its status", () => {
    actions.startLive();
    expect(useStore.getState().liveStatus).toBe("connecting");
    expect(vi.mocked(api.openModelStream).mock.calls[0]?.[0]).toBe(MODEL_REF);

    streams[0]?.handlers.onStatus("open");
    expect(useStore.getState().liveStatus).toBe("live");
    streams[0]?.handlers.onStatus("reconnecting");
    expect(useStore.getState().liveStatus).toBe("reconnecting");
  });

  it("starting again closes the stream before it, so there is one connection per model", () => {
    actions.startLive();
    actions.startLive();

    expect(streams.map((stream) => stream.closed)).toEqual([true, false]);
  });

  it("stopping closes it", () => {
    actions.startLive();
    actions.stopLive();

    expect(streams[0]?.closed).toBe(true);
    expect(useStore.getState().liveStatus).toBe("off");
  });

  it("does nothing without a selected model", () => {
    useStore.setState({ selected: null });
    actions.startLive();

    expect(streams).toEqual([]);
  });
});

describe("events", () => {
  beforeEach(() => actions.startLive());

  it("a delta changes the model in place: only the changed entity is a new object, the structure is the same arrays", () => {
    emit({ kind: "delta", id: "e-1", delta: { observedAt: "2026-11-11T10:00:30.000Z", entities: { upsert: [entity("ss", "Unhealthy")] } } });

    const state = useStore.getState();
    const model = state.model.kind === "success" ? state.model.value : MODEL;
    expect(model.entities.map((item) => item.healthState)).toEqual(["Healthy", "Unhealthy", "Healthy"]);
    expect(model.entities[0]).toBe(MODEL.entities[0]);
    expect(model.entities[2]).toBe(MODEL.entities[2]);
    expect(model.relationships).toBe(MODEL.relationships);
    expect(state.lastObservedAt).toBe("2026-11-11T10:00:30.000Z");
  });

  it("a change is announced, remembered and flashed", () => {
    emit({ kind: "delta", id: "e-1", delta: { observedAt: "2026-11-11T10:00:30.000Z", entities: { upsert: [entity("ss", "Unhealthy")] } } });

    const state = useStore.getState();
    expect(state.liveAnnouncement).toBe("Session Storage is now Unhealthy");
    expect(state.liveChanged.ss).toBe(Date.parse("2026-11-11T10:00:30.000Z"));
    expect(vi.mocked(flash.flashEntities)).toHaveBeenCalledWith(["ss"]);
  });

  it("a delta that changes nothing a view draws keeps the model object", () => {
    const before = useStore.getState().model;

    emit({ kind: "delta", id: "e-1", delta: { observedAt: "2026-11-11T10:01:00.000Z" } });

    expect(useStore.getState().model).toBe(before);
    expect(useStore.getState().lastObservedAt).toBe("2026-11-11T10:01:00.000Z");
    expect(vi.mocked(flash.flashEntities)).not.toHaveBeenCalled();
  });

  it("a snapshot equal to what is held changes no entity object, and a different one changes only what differs", () => {
    const same: HealthModel = JSON.parse(JSON.stringify(MODEL));
    emit({ kind: "snapshot", id: "e-0", model: same });
    const held = useStore.getState().model;
    expect(held.kind === "success" && held.value.entities).toBe(MODEL.entities);

    emit({ kind: "snapshot", id: "e-5", model: { ...same, entities: [entity("root"), entity("ss", "Degraded"), entity("api")] } });
    const next = useStore.getState().model;
    expect(next.kind === "success" && next.value.entities[0]).toBe(MODEL.entities[0]);
    expect(next.kind === "success" && next.value.entities[1]?.healthState).toBe("Degraded");
  });

  it("the first snapshot fills a model that was not loaded yet", () => {
    useStore.setState({ model: { kind: "loading" } });

    emit({ kind: "snapshot", id: "e-0", model: MODEL });

    expect(useStore.getState().model).toEqual({ kind: "success", value: MODEL });
  });

  it("a delta before any model is held is ignored", () => {
    useStore.setState({ model: { kind: "loading" } });

    emit({ kind: "delta", id: "e-1", delta: { entities: { upsert: [entity("x")] } } });

    expect(useStore.getState().model).toEqual({ kind: "loading" });
  });

  it("the timeline in the store takes the new points and transitions of a delta", () => {
    const overview: TimelineResponse = {
      model: "hm-a",
      observedAt: "",
      range: { from: new Date(0).toISOString(), to: new Date(Date.parse("2026-11-11T10:00:00Z")).toISOString() },
      retentionDays: 30,
      resolution: 0,
      partial: false,
      entities: [{ name: "ss", displayName: "Session Storage", parents: [], state: 1, signals: [] }],
      states: [{ entity: "ss", transitions: [{ t: 100, from: 0, to: 1, reason: null }], complete: true, earliest: null }],
      series: [],
      annotations: [],
      reports: [],
      failures: [],
    };
    useStore.setState({ timelineStatus: "ready", timelineData: mergeResponse(EMPTY_TIMELINE, overview) });
    const t = Date.parse("2026-11-11T10:00:30.000Z");

    emit({ kind: "delta", id: "e-1", delta: { observedAt: "2026-11-11T10:00:30.000Z", entities: { upsert: [entity("ss", "Unhealthy")] }, timeline: { transitions: [{ entity: "ss", t, from: 1, to: 3, reason: "SignalTransition" }] } } });

    const data = useStore.getState().timelineData;
    expect(data.states.ss?.transitions.map((row) => row.to)).toEqual([1, 3]);
    expect(data.entities[0]?.state).toBe(3);
    expect(data.now).toBe(t);
  });

  it("remembers how far the server's clock is from the browser's", () => {
    vi.setSystemTime(Date.parse("2026-11-11T10:00:00.000Z"));

    emit({ kind: "delta", id: "e-1", delta: { observedAt: "2026-11-11T10:00:05.000Z", entities: { upsert: [entity("ss", "Degraded")] } } });

    expect(useStore.getState().liveSkew).toBe(5000);
  });
});

describe("pause, resume and the fallback", () => {
  it("pausing closes the stream and holds the model still; resuming opens a new one", () => {
    actions.startLive();
    streams[0]?.handlers.onStatus("open");

    actions.pauseLive();
    expect(streams[0]?.closed).toBe(true);
    expect(useStore.getState().liveStatus).toBe("paused");
    streams[0]?.handlers.onStatus("open");
    expect(useStore.getState().liveStatus).toBe("paused");

    actions.resumeLive();
    expect(streams).toHaveLength(2);
    expect(useStore.getState().liveStatus).toBe("connecting");
  });

  it("a model chosen while paused stays paused and opens nothing", () => {
    actions.pauseLive();

    actions.startLive();

    expect(streams).toEqual([]);
    expect(useStore.getState().liveStatus).toBe("paused");
  });

  it("a refused stream falls back to reading the model every minute, and says so", async () => {
    vi.mocked(useStore.getState().loadHealthModel);
    const load = vi.spyOn(useStore.getState(), "loadHealthModel").mockResolvedValue();
    actions.startLive();
    const refusal: ApiError = { code: "live_unavailable", message: "Busy.", retryable: true, operationId: null };

    streams[0]?.handlers.onFailure(refusal);

    expect(useStore.getState()).toMatchObject({ liveStatus: "polling", liveError: refusal });
    expect(streams[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(POLL_FALLBACK_MS * 2);
    expect(load.mock.calls.length + vi.mocked(api.fetchHealthModel).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    { name: "a refusal that is not retryable", error: { code: "forbidden", message: "No.", retryable: false, operationId: null } },
    { name: "an app without the route", error: { code: "not_found", message: "Unknown route.", retryable: false, operationId: null } },
  ])("$name leaves the model as it is and does not poll", async ({ error }) => {
    actions.startLive();
    streams[0]?.handlers.onFailure(error);
    vi.mocked(api.fetchHealthModel).mockClear();

    await vi.advanceTimersByTimeAsync(POLL_FALLBACK_MS * 3);

    expect(useStore.getState()).toMatchObject({ liveStatus: "off", liveError: error });
    expect(vi.mocked(api.fetchHealthModel)).not.toHaveBeenCalled();
  });

  it("stopping ends the fallback too", async () => {
    actions.startLive();
    streams[0]?.handlers.onFailure({ code: "live_unavailable", message: "Busy.", retryable: true, operationId: null });
    actions.stopLive();
    vi.mocked(api.fetchHealthModel).mockClear();

    await vi.advanceTimersByTimeAsync(POLL_FALLBACK_MS * 3);

    expect(vi.mocked(api.fetchHealthModel)).not.toHaveBeenCalled();
  });
});

describe("the server's clock", () => {
  it.each([
    { name: "a few seconds ahead", observed: 5_000, now: 0, skew: 5_000 },
    { name: "a few seconds behind", observed: -3_000, now: 0, skew: -3_000 },
    { name: "ten minutes off is still a clock", observed: 600_000, now: 0, skew: 600_000 },
    { name: "months off is old data, not a clock", observed: -90 * 24 * 3600_000, now: 0, skew: 0 },
    { name: "a time that is not a time", observed: Number.NaN, now: 0, skew: 0 },
  ])("reads $name", ({ observed, now, skew }) => {
    expect(clockSkew(observed, now)).toBe(skew);
  });
});
