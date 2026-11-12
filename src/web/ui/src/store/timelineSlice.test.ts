import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, Entity, HealthModel, ModelRef } from "../model/types";
import { buildFixture } from "../model/timelineFixture";
import { seriesKey, type TimelineResponse } from "../model/timeline";
import { entityKey, rootKeys } from "../model/timelineRows";
import { DAY, HOUR, MINUTE } from "../model/timelineScale";
import { RETENTION, WEEK, tileOf } from "../model/timelineTiles";
import type { Demand } from "../model/timelinePlan";
import { createTileCache, memoryStorage } from "../timeline/tileCache";
import * as api from "./api";
import {
  TIMELINE_MAX_HEIGHT,
  TIMELINE_MIN_HEIGHT,
  cacheScope,
  cancelTimelineSignals,
  historyStart,
  selectEntityAt,
  selectLastChange,
  selectModelAt,
  selectModelState,
  selectMomentMinute,
  selectedMoment,
  setTimelineCache,
  timelineIdle,
} from "./timelineSlice";
import { actions, useStore } from "./store";

vi.mock("./api");

// A Wednesday noon: the week it is in began the Thursday before.
const NOW = Date.parse("2026-11-11T12:00:00Z");
const TODAY = tileOf(NOW, DAY) * DAY;
const THIS_WEEK = tileOf(NOW, WEEK) * WEEK;
const MODEL: ModelRef = { id: "/a", name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a", location: null, provisioningState: null };
const FIXTURE = buildFixture({ now: NOW, days: 5, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 2, signalsPerResource: 2 });
const FAILURE: ApiError = { code: "http_error", message: "Request failed with status 503.", retryable: true, operationId: null };
const RESOURCE = FIXTURE.entities.find((entity) => entity.signals.length > 0)!;
const KEY = seriesKey(RESOURCE.name, RESOURCE.signals[0]!.name);

function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const answer = (query: api.TimelineQuery, fixture = FIXTURE): TimelineResponse =>
  fixture.answer({ from: query.from, to: query.to, include: query.include, entities: query.entities ?? [], signals: query.signals ?? [], resolution: query.resolution ?? 0 });

/** The app answers from the fixture: the window, the entities, the parts and the resolution that are asked for. */
function serve(fixture = FIXTURE): void {
  vi.mocked(api.fetchTimeline).mockImplementation(async (_selection, query) => answer(query, fixture));
}

const entityOf = (name: string): Entity => ({
  name,
  displayName: name,
  healthState: "Healthy",
  impact: "Standard",
  canvasPosition: null,
  discoveredBy: null,
  parents: [],
  children: [],
  unlinked: false,
  latestEvaluationAt: null,
  latestTransitionAt: null,
  signals: [],
  report: { eligible: false, signalName: null },
});

/** The model the graph shows, with the entities of a fixture. */
const graphOf = (fixture = FIXTURE): HealthModel => ({
  model: { id: null, name: "root", location: null, provisioningState: null, healthState: "Healthy" },
  observedAt: new Date(NOW).toISOString(),
  entities: fixture.entities.map((item) => entityOf(item.name)),
  relationships: [],
  reportOptions: { signalName: "x", healthStates: [], values: [], expiries: [], reasonPresets: [] },
});

const demand = (parts: Partial<Demand> = {}): Demand => ({ view: { from: NOW - DAY, to: NOW }, width: 1000, lanes: [], moment: null, watched: [], ...parts });
const queries = (): readonly api.TimelineQuery[] => vi.mocked(api.fetchTimeline).mock.calls.map((call) => call[1]);
const seriesQueries = (): readonly api.TimelineQuery[] => queries().filter((query) => query.include.includes("signals"));

/** The timeline of the selected model, opened and read. */
async function open(parts: Partial<Demand> = {}): Promise<void> {
  actions.resetTimeline();
  actions.wantTimeline(demand(parts));
  await timelineIdle();
}

async function show(parts: Partial<Demand>): Promise<void> {
  actions.wantTimeline(demand(parts));
  await timelineIdle();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setTimelineCache(null);
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ selected: MODEL });
  actions.resetTimeline();
});

afterEach(() => {
  cancelTimelineSignals();
});

describe("opening and the link", () => {
  it.each([
    { search: "", open: false, view: null },
    { search: "?timeline=1", open: true, view: null },
    { search: "?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z", open: true, view: { t0: Date.parse("2026-11-10T10:00:00Z"), t1: Date.parse("2026-11-10T12:00:00Z") } },
  ])("reads $search", ({ search, open: opened, view }) => {
    actions.initializeTimeline(search);

    expect(useStore.getState().timelineOpen).toBe(opened);
    expect(useStore.getState().timelineView).toEqual(view);
  });

  it.each([
    { search: "?timeline=1&fullscreen=1", fullscreen: true },
    { search: "?timeline=1", fullscreen: false },
    { search: "?fullscreen=1", fullscreen: false },
  ])("reads full screen from $search", ({ search, fullscreen }) => {
    actions.initializeTimeline(search);

    expect(useStore.getState().timelineFullscreen).toBe(fullscreen);
  });

  it("opens, closes and toggles", () => {
    actions.openTimeline();
    expect(useStore.getState().timelineOpen).toBe(true);
    actions.toggleTimeline();
    expect(useStore.getState().timelineOpen).toBe(false);
    actions.toggleTimeline();
    expect(useStore.getState().timelineOpen).toBe(true);
    actions.closeTimeline();
    expect(useStore.getState().timelineOpen).toBe(false);
  });

  it("closing leaves full screen and forgets what was to be shown, so the next open is a plain one", () => {
    actions.showInTimeline("a");
    actions.setTimelineFullscreen(true);

    actions.closeTimeline();

    expect(useStore.getState()).toMatchObject({ timelineOpen: false, timelineFullscreen: false, timelineFocus: null });
  });

  it("showing an entity opens the timeline, and asking again for the same one is a new request", () => {
    actions.showInTimeline("a");
    const first = useStore.getState().timelineFocus;
    actions.showInTimeline("a", entityKey(["r", "a"]));

    expect(useStore.getState().timelineOpen).toBe(true);
    expect(first).toEqual({ name: "a", key: null, seq: 1 });
    expect(useStore.getState().timelineFocus).toEqual({ name: "a", key: entityKey(["r", "a"]), seq: 2 });
  });

  it.each([
    [10, TIMELINE_MIN_HEIGHT],
    [400.4, 400],
    [5000, TIMELINE_MAX_HEIGHT],
  ])("a height of %d is kept as %d", (height, expected) => {
    actions.setTimelineHeight(height);

    expect(useStore.getState().timelineHeight).toBe(expected);
  });
});

describe("the overview", () => {
  it("opens the rows of the roots the first time the model is read, and then keeps what the viewer opened", async () => {
    serve();
    await open();

    expect(useStore.getState().timelineExpanded).toEqual(rootKeys(FIXTURE.entities));

    actions.collapseTimelineEntities();
    await actions.refreshTimeline();

    expect(useStore.getState().timelineExpanded).toEqual([]);
  });

  it("of a model the graph already shows is one request for the structure and the whole retention, and shows the last day", async () => {
    serve();
    useStore.setState({ model: { kind: "success", value: graphOf() } });

    await open();

    const state = useStore.getState();
    const [selection, query] = vi.mocked(api.fetchTimeline).mock.calls[0] ?? [];
    expect(api.fetchTimeline).toHaveBeenCalledTimes(1);
    expect(selection).toBe(MODEL);
    expect(query).toMatchObject({ from: tileOf(NOW - RETENTION, WEEK) * WEEK, to: THIS_WEEK + WEEK, include: ["structure", "states", "annotations", "reports"], entities: null });
    expect(state.timelineStatus).toBe("ready");
    expect(state.timelineData.entities.length).toBe(FIXTURE.entities.length);
    expect(state.timelineView).toEqual({ t0: NOW - DAY, t1: NOW });
  });

  it("of a model nobody has named yet is the week on screen first, then the rest", async () => {
    serve();

    await open();

    expect(queries().map((query) => [query.include.join(), query.from])).toEqual([
      ["structure,states,annotations,reports", THIS_WEEK],
      ["states,annotations,reports", tileOf(NOW - RETENTION, WEEK) * WEEK],
    ]);
    expect(Object.keys(useStore.getState().timelineData.states)).toHaveLength(FIXTURE.entities.length);
    expect(useStore.getState().timelineData.states[RESOURCE.name]?.covered).toEqual([{ from: useStore.getState().timelineData.floor, to: NOW }]);
  });

  it("keeps a view a link named", async () => {
    serve();
    const view = { t0: NOW - 3 * HOUR, t1: NOW - HOUR };
    actions.initializeTimeline(`?timeline=1&from=${view.t0}&to=${view.t1}`);

    await open({ view: { from: view.t0, to: view.t1 } });

    expect(useStore.getState().timelineView).toEqual(view);
  });

  it("a failure before anything is shown is a failed status with its error, and a retry reads it", async () => {
    vi.mocked(api.fetchTimeline).mockRejectedValue(FAILURE);

    await open();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "failed", timelineError: FAILURE });

    serve();
    await actions.loadTimelineOverview();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "ready", timelineError: null });
  });

  it("a failed refresh keeps what is on screen and says why, and the next refresh reads it", async () => {
    serve();
    await open();
    actions.openTimeline();
    vi.setSystemTime(NOW + MINUTE);
    vi.mocked(api.fetchTimeline).mockRejectedValue(FAILURE);

    await actions.refreshTimeline();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "ready", timelineError: FAILURE });
    expect(useStore.getState().timelineData.entities.length).toBeGreaterThan(0);

    serve();
    vi.setSystemTime(NOW + 2 * MINUTE);
    await actions.refreshTimeline();

    expect(useStore.getState().timelineError).toBeNull();
  });

  it("a live change that arrived while the answer was on its way is in the timeline once it answers", async () => {
    const slow = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValueOnce(slow.promise);
    actions.wantTimeline(demand());
    const name = FIXTURE.entities[0]?.name ?? "";
    const t = NOW + 1000;
    useStore.setState({ timelineHeld: [{ timeline: { transitions: [{ entity: name, t, from: 1, to: 3, reason: "SignalTransition" }] }, observed: t }] });
    serve();

    slow.resolve(answer(queries()[0]!));
    await timelineIdle();

    expect(useStore.getState().timelineData.states[name]?.transitions.at(-1)).toMatchObject({ t, to: 3 });
  });

  it("an answer that arrives after a reset is dropped", async () => {
    const late = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValueOnce(late.promise);
    actions.wantTimeline(demand());

    actions.resetTimeline();
    late.resolve(FIXTURE.overview(NOW - DAY, NOW));
    await timelineIdle();

    expect(useStore.getState().timelineStatus).toBe("idle");
    expect(useStore.getState().timelineData.entities).toEqual([]);
  });
});

describe("the lanes", () => {
  it("are read once for the entities that show, and held by entity and signal", async () => {
    serve();
    await open();

    actions.wantTimeline(demand({ lanes: [RESOURCE.name] }));
    expect(useStore.getState().timelineLoading).toEqual([RESOURCE.name]);
    await timelineIdle();
    await show({ lanes: [RESOURCE.name], view: { from: NOW - 6 * HOUR, to: NOW } });

    const held = useStore.getState().timelineData.series[KEY];
    expect(held?.points.length).toBeGreaterThan(250);
    expect(held?.covered).toEqual([{ from: TODAY - DAY, to: NOW }]);
    expect(useStore.getState().timelineLoading).toEqual([]);
    expect(seriesQueries()).toHaveLength(1);
    expect(seriesQueries()[0]).toMatchObject({ include: ["signals"], entities: [RESOURCE.name], signals: null, from: TODAY - DAY, to: TODAY + DAY, resolution: 0 });
  });

  it.each([
    { name: "a day", span: DAY, level: 0, resolution: 0 },
    { name: "a week", span: 7 * DAY, level: 1, resolution: 900 },
    { name: "the whole retention", span: RETENTION, level: 2, resolution: 3600 },
  ])("$name is read and drawn at level $level", async ({ span, level, resolution }) => {
    serve();
    await open();

    await show({ lanes: [RESOURCE.name], view: { from: NOW - span, to: NOW } });

    expect(useStore.getState().timelineShown.level).toBe(level);
    expect(seriesQueries().every((query) => (query.resolution ?? 0) === resolution)).toBe(true);
    expect(useStore.getState().timelineSeries.series[KEY]?.[level]?.rows.length).toBeGreaterThan(0);
    expect(useStore.getState().timelineData.series[KEY]?.points).toBe(useStore.getState().timelineSeries.series[KEY]?.[level]?.rows);
  });

  it("a failed request marks its series so they are not asked for again, and a retry clears the mark and reads them", async () => {
    serve();
    await open();
    vi.mocked(api.fetchTimeline).mockRejectedValue(FAILURE);

    await show({ lanes: [RESOURCE.name] });
    await show({ lanes: [RESOURCE.name], view: { from: NOW - 23 * HOUR, to: NOW } });

    expect(seriesQueries()).toHaveLength(1);
    expect(useStore.getState().timelineData.series[KEY]?.error?.code).toBe("http_error");
    expect(useStore.getState().timelineError).toEqual(FAILURE);
    expect(useStore.getState().timelineLoading).toEqual([]);

    serve();
    actions.retryTimelineSignals([RESOURCE.name]);
    expect(useStore.getState().timelineData.series[KEY]?.error).toBeNull();
    await timelineIdle();

    expect(useStore.getState().timelineData.series[KEY]?.points.length).toBeGreaterThan(250);
  });

  it("cancelling aborts what is in flight and leaves no mark", async () => {
    serve();
    await open();
    const never = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValue(never.promise);
    actions.wantTimeline(demand({ lanes: [RESOURCE.name] }));
    const signal = vi.mocked(api.fetchTimeline).mock.calls.at(-1)?.[2];

    cancelTimelineSignals();
    never.reject(new DOMException("aborted", "AbortError"));
    await timelineIdle();

    expect(signal?.aborted).toBe(true);
    expect(useStore.getState().timelineError).toBeNull();
    expect(useStore.getState().timelineLoading).toEqual([]);
  });

  it("refresh reads the week and the day that are still open, and nothing that closed", async () => {
    serve();
    await open({ lanes: [RESOURCE.name] });
    actions.openTimeline();
    vi.mocked(api.fetchTimeline).mockClear();
    vi.setSystemTime(NOW + MINUTE);

    await actions.refreshTimeline();

    expect(queries().map((query) => [query.include.join(), query.from, query.to])).toEqual([
      ["structure,states,annotations,reports", THIS_WEEK, THIS_WEEK + WEEK],
      ["signals", TODAY, TODAY + DAY],
    ]);
  });

  it("refresh reads nothing while the timeline is closed: it is read afresh when it opens", async () => {
    serve();
    await open();
    vi.mocked(api.fetchTimeline).mockClear();

    await actions.refreshTimeline();

    expect(api.fetchTimeline).not.toHaveBeenCalled();
  });
});

describe("rows and the view", () => {
  it("expands, collapses and toggles rows", () => {
    actions.toggleTimelineEntity("a");
    actions.expandTimelineEntities(["a", "b"]);
    expect(useStore.getState().timelineExpanded).toEqual(["a", "b"]);
    actions.toggleTimelineEntity("a");
    expect(useStore.getState().timelineExpanded).toEqual(["b"]);
    actions.collapseTimelineEntities();
    expect(useStore.getState().timelineExpanded).toEqual([]);
  });

  it("clamps a view to the history and ignores one that did not change", async () => {
    serve();
    await open();

    actions.setTimelineView({ t0: NOW - 100 * DAY, t1: NOW + DAY });
    const wide = useStore.getState().timelineView;
    expect(wide?.t1).toBe(NOW);
    expect(wide?.t0).toBe(historyStart(useStore.getState().timelineData));

    const before = useStore.getState();
    actions.setTimelineView({ ...wide! });
    expect(useStore.getState().timelineView).toBe(before.timelineView);
  });

  it("resetting forgets the data, the lanes and the selected moment", async () => {
    serve();
    await open();
    actions.expandTimelineEntities(["a"]);
    actions.pinTimeline(5);

    actions.resetTimeline();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "idle", timelineExpanded: [], timelinePinned: null });
    expect(useStore.getState().timelineData.entities).toEqual([]);
    expect(useStore.getState().timelineSeries.entities).toEqual([]);
  });

  it("history starts at the first transition seen, a little before it", async () => {
    serve();
    await open();

    const start = historyStart(useStore.getState().timelineData);

    expect(start).toBeGreaterThanOrEqual(useStore.getState().timelineData.floor);
    expect(start).toBeLessThan(NOW - 4 * DAY);
  });
});

describe("the selected moment", () => {
  const TROUBLED = buildFixture({ now: NOW, days: 5, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 4, signalsPerResource: 2 });
  const graph = graphOf(TROUBLED);
  const incident = TROUBLED.incidents[1] as readonly [number, number];

  it("is one field: null is now, and pinning the timeline selects it", () => {
    actions.setTimelineOrder("worst");
    expect(selectedMoment(useStore.getState())).toBeNull();

    actions.pinTimeline(123);
    expect(useStore.getState()).toMatchObject({ timelineOrder: "worst", timelinePinned: 123 });
    expect(selectedMoment(useStore.getState())).toBe(123);

    actions.selectMoment(456);
    expect(selectedMoment(useStore.getState())).toBe(456);
    actions.pinTimeline(null);
    expect(selectedMoment(useStore.getState())).toBeNull();
  });

  it.each([
    { name: "a window that follows now stops where it is while a moment is selected and follows again after", following: true, during: false, after: true },
    { name: "a window that did not follow stays where it is", following: false, during: false, after: false },
  ])("$name", async ({ following, during, after }) => {
    serve();
    await open();
    if (!following) actions.setTimelineView({ t0: NOW - 3 * DAY, t1: NOW - 2 * DAY });
    const view = useStore.getState().timelineView;

    actions.selectMoment(NOW - HOUR);
    actions.selectMoment(NOW - 2 * HOUR);
    expect(useStore.getState().timelineFollow).toBe(during);
    expect(useStore.getState().timelineView).toEqual(view);

    actions.selectMoment(null);
    expect(useStore.getState().timelineFollow).toBe(after);
    expect(useStore.getState().timelineView).toEqual(view);
  });

  it("a window the viewer moved away while a moment was selected stays where it was put when the selection is cleared", async () => {
    serve();
    await open();
    actions.selectMoment(NOW - HOUR);
    const moved = { t0: NOW - 3 * DAY, t1: NOW - 2 * DAY };

    actions.setTimelineView(moved);
    actions.selectMoment(null);

    expect(useStore.getState()).toMatchObject({ timelineFollow: false, timelineView: moved });
  });

  it("a window that followed for a while stops at the now it had reached, not where it was when the following began", async () => {
    serve();
    await open();
    const later = NOW + 20 * MINUTE;
    useStore.setState((state) => ({ timelineData: { ...state.timelineData, now: later } }));

    actions.selectMoment(NOW - HOUR);

    expect(useStore.getState().timelineView).toEqual({ t0: later - DAY, t1: later });
  });

  it("the model at the moment has the states of then, and the live model itself is given while none is selected", async () => {
    serve(TROUBLED);
    useStore.setState({ model: { kind: "success", value: graph } });
    await open();

    expect(selectModelAt(useStore.getState())).toBe(graph);

    actions.selectMoment(incident[0] + 10 * MINUTE);
    const then = selectModelAt(useStore.getState());
    actions.selectMoment(incident[1] + 30 * MINUTE);
    const after = selectModelAt(useStore.getState());

    expect(then?.model.healthState).not.toBe("Healthy");
    expect(then?.entities.some((item) => item.healthState === "Unhealthy" || item.healthState === "Degraded")).toBe(true);
    expect(after?.entities.every((item) => item.healthState === "Healthy")).toBe(true);
    expect(then?.relationships).toBe(graph.relationships);
    actions.selectMoment(null);
    expect(selectModelAt(useStore.getState())).toBe(graph);
  });

  it("closing the timeline returns the page to now", () => {
    actions.openTimeline();
    actions.selectMoment(NOW - HOUR);

    actions.closeTimeline();

    expect(selectedMoment(useStore.getState())).toBeNull();
  });

  const AT = NOW - 2 * HOUR - 10 * MINUTE;
  it.each([
    { name: "a link at a past moment", search: `?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-11T10:00:00Z&at=${new Date(AT).toISOString()}`, expected: { timelineOpen: true, timelinePinned: AT, timelineFollow: false, timelineFollowPaused: false } },
    { name: "a link at a past moment of a window that followed now", search: `?timeline=1&live=1&span=${DAY}&at=${new Date(AT).toISOString()}`, expected: { timelineOpen: true, timelinePinned: AT, timelineFollow: false, timelineFollowPaused: true, timelineView: { t0: NOW - DAY, t1: NOW } } },
    { name: "a link that names only a moment", search: `?at=${new Date(AT).toISOString()}`, expected: { timelineOpen: true, timelinePinned: AT, timelineFollow: false, timelineFollowPaused: true } },
    { name: "a link at a moment the page cannot show", search: "?timeline=1&at=2020-01-01T00:00:00Z", expected: { timelineOpen: true, timelinePinned: null, timelineFollow: true, timelineFollowPaused: false } },
    { name: "a link at now", search: "?timeline=1", expected: { timelineOpen: true, timelinePinned: null, timelineFollow: true } },
  ])("$name opens the page at it", ({ search, expected }) => {
    actions.initializeTimeline(search);

    expect(useStore.getState()).toMatchObject(expected);
  });

  it("the moment of a link stays through the first set-up of its timeline, returns to live with Back to now, and another model begins at now", async () => {
    serve();
    actions.initializeTimeline(`?timeline=1&live=1&span=${DAY}&at=${new Date(AT).toISOString()}`);

    actions.resetTimeline(true);
    await show({});
    expect(useStore.getState()).toMatchObject({ timelinePinned: AT, timelineFollow: false, timelineFollowPaused: true });

    actions.selectMoment(null);
    expect(useStore.getState()).toMatchObject({ timelinePinned: null, timelineFollow: true, timelineFollowPaused: false });

    actions.selectMoment(AT);
    actions.resetTimeline();
    expect(useStore.getState()).toMatchObject({ timelinePinned: null, timelineFollowPaused: false });
  });

  it("a comparison is about now: selecting a moment closes it, and opening one returns to now", () => {
    useStore.setState({ compare: true });

    actions.selectMoment(AT);
    expect(useStore.getState()).toMatchObject({ compare: false, timelinePinned: AT });
    expect(useStore.getState().announcement).toContain("comparison is closed");

    actions.setCompare(true);
    expect(useStore.getState()).toMatchObject({ compare: true, timelinePinned: null });
    expect(useStore.getState().announcement).toContain("Back to now");

    actions.setCompare(false);
    actions.setCompare(true);
    expect(useStore.getState().timelinePinned).toBeNull();
  });

  it("the selected entity, the state of the model and the minute are read at the moment", async () => {
    serve(TROUBLED);
    useStore.setState({ model: { kind: "success", value: graph }, selectedName: "root" });
    await open();

    expect(selectEntityAt(useStore.getState())).toBe(graph.entities.find((item) => item.name === "root"));
    expect(selectModelState(useStore.getState())).toBe("Healthy");
    expect(selectMomentMinute(useStore.getState())).toBeNull();

    actions.selectMoment(incident[0] + 10 * MINUTE + 12_345);
    expect(selectEntityAt(useStore.getState())?.healthState).not.toBe("Healthy");
    expect(selectModelState(useStore.getState())).toBe(selectEntityAt(useStore.getState())?.healthState);
    expect(selectMomentMinute(useStore.getState())).toBe(incident[0] + 10 * MINUTE);

    useStore.setState({ selectedName: "ghost" });
    expect(selectEntityAt(useStore.getState())).toBeUndefined();
  });

  it.each([
    { name: "now: the newest change its detail lists", moment: null, selected: "root", detailOf: "root", expected: "2026-11-11T09:00:00Z" },
    { name: "now, while the detail is of another entity: nothing", moment: null, selected: "root", detailOf: "other", expected: null },
    { name: "nothing without a selected entity", moment: null, selected: null, detailOf: "root", expected: null },
    { name: "at a moment: the last change before it that the history holds, whatever the detail of now says", moment: incident[1] + 30 * MINUTE, selected: "root", detailOf: "root", expected: "history" },
  ])("the selected entity last changed, $name", async ({ moment, selected, detailOf, expected }) => {
    serve(TROUBLED);
    const transitions = [
      { previousState: "Healthy" as const, healthState: "Degraded" as const, occurredAt: "2026-11-11T07:00:00Z" },
      { previousState: "Degraded" as const, healthState: "Healthy" as const, occurredAt: "2026-11-11T09:00:00Z" },
      { previousState: null, healthState: null, occurredAt: null },
    ];
    useStore.setState({
      model: { kind: "success", value: graph },
      selectedName: selected,
      detail: { kind: "success", value: { entity: entityOf(detailOf), observedAt: "", transitions, canonicalSignal: { name: "x", current: null, history: [] } } },
    });
    await open();
    if (moment !== null) actions.selectMoment(moment);

    const changed = selectLastChange(useStore.getState());

    if (expected !== "history") expect(changed).toBe(expected);
    else {
      const rows = useStore.getState().timelineSeries.states.root?.rows ?? [];
      const last = [...rows].reverse().find((row) => row.t <= (moment as number));
      expect(last).toBeDefined();
      expect(changed).toBe(new Date(last?.t ?? 0).toISOString());
    }
  });

  it("is null until a model is loaded", () => {
    expect(selectModelAt(useStore.getState())).toBeNull();
  });

  it("the entities other views watch are remembered, and the same list changes nothing", () => {
    actions.watchEntities(["a", "b"]);
    const held = useStore.getState().timelineWatched;
    actions.watchEntities(["a", "b"]);

    expect(useStore.getState().timelineWatched).toBe(held);
    expect(held).toEqual(["a", "b"]);
  });

  it("reads the signals of what is watched around the moment, at full detail", async () => {
    serve();
    await open();
    const moment = NOW - 3 * DAY;

    await show({ moment, watched: [RESOURCE.name] });

    expect(seriesQueries().map((query) => [query.entities, query.from, query.to, query.resolution])).toEqual([[[RESOURCE.name], tileOf(moment, DAY) * DAY, (tileOf(moment, DAY) + 1) * DAY, 0]]);
  });
});

describe("live mode", () => {
  it("follows now by default, a link names a following window by its length, and moving away stops following", async () => {
    expect(useStore.getState().timelineFollow).toBe(true);
    actions.initializeTimeline("?timeline=1&live=1&span=3600000");
    expect(useStore.getState().timelineView).toEqual({ t0: NOW - HOUR, t1: NOW });
    expect(useStore.getState().timelineFollow).toBe(true);
    serve();
    await open();

    actions.setTimelineView({ t0: NOW - 3 * DAY, t1: NOW - 2 * DAY });
    expect(useStore.getState().timelineFollow).toBe(false);

    actions.followTimeline(true);
    const view = useStore.getState().timelineView;
    expect(useStore.getState().timelineFollow).toBe(true);
    expect(view?.t1).toBe(NOW);
    expect((view?.t1 ?? 0) - (view?.t0 ?? 0)).toBe(DAY);
  });

  it("a window that still ends at now stays followed when it is zoomed", async () => {
    serve();
    await open();

    actions.setTimelineView({ t0: NOW - 6 * HOUR, t1: NOW });

    expect(useStore.getState().timelineFollow).toBe(true);
  });

  it("a link without a live window is not followed", () => {
    actions.initializeTimeline("?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z");

    expect(useStore.getState().timelineFollow).toBe(false);
  });
});

describe("the browser's cache", () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));
  const ADA = { name: "Ada", username: "ada@example.test", tenantId: "tenant-a" };

  it.each([
    { name: "nobody signed in, on a development server", account: null, owner: "local" },
    { name: "a signed-in user", account: ADA, owner: "tenant-a/ada@example.test" },
    { name: "the same user in another directory", account: { ...ADA, tenantId: "tenant-b" }, owner: "tenant-b/ada@example.test" },
  ])("belongs to $name", ({ account, owner }) => {
    expect(cacheScope({ account, selected: MODEL })).toEqual({ owner, model: "sub-a/rg-a/hm-a" });
    expect(cacheScope({ account, selected: null })).toBeNull();
  });

  it("paints what the browser kept before the app answers, then is current and starts again from now", async () => {
    setTimelineCache(createTileCache(memoryStorage(), { delayMs: 0 }));
    serve();
    await open({ lanes: [RESOURCE.name] });
    await settle();
    const first = vi.mocked(api.fetchTimeline).mock.calls.length;
    vi.setSystemTime(NOW + 2 * HOUR);
    const late = pending<void>();
    vi.mocked(api.fetchTimeline).mockImplementation(async (_selection, query) => {
      await late.promise;
      return { ...answer(query), range: { from: new Date(query.from).toISOString(), to: new Date(NOW + 2 * HOUR).toISOString() } };
    });

    // A reload: nothing is in the store, and no view is named.
    useStore.setState({ timelineView: null });
    actions.resetTimeline();
    expect(useStore.getState().timelineData.entities).toEqual([]);
    actions.wantTimeline(demand({ lanes: [RESOURCE.name], view: { from: NOW + 2 * HOUR - DAY, to: NOW + 2 * HOUR } }));
    await settle();

    const kept = useStore.getState();
    expect(kept).toMatchObject({ timelineStatus: "ready", timelineStale: true });
    expect(kept.timelineData.entities.length).toBe(FIXTURE.entities.length);
    expect(kept.timelineData.series[KEY]?.points.length).toBeGreaterThan(250);
    expect(queries().slice(first).map((query) => query.from)).toEqual([THIS_WEEK, TODAY]);

    late.resolve();
    await timelineIdle();

    expect(useStore.getState().timelineStale).toBe(false);
    expect(useStore.getState().timelineView).toEqual({ t0: NOW + 2 * HOUR - DAY, t1: NOW + 2 * HOUR });
  });

  it("is never shown to another user: they start empty and read from the app", async () => {
    setTimelineCache(createTileCache(memoryStorage(), { delayMs: 0 }));
    serve();
    useStore.setState({ account: ADA });
    await open();
    await settle();
    const first = vi.mocked(api.fetchTimeline).mock.calls.length;
    const late = pending<void>();
    vi.mocked(api.fetchTimeline).mockImplementation(async (_selection, query) => {
      await late.promise;
      return answer(query);
    });

    useStore.setState({ account: { ...ADA, username: "bob@example.test" } });
    actions.resetTimeline();
    actions.wantTimeline(demand());
    await settle();

    expect(useStore.getState()).toMatchObject({ timelineStale: false });
    expect(useStore.getState().timelineData.entities).toEqual([]);
    expect(queries().slice(first)[0]).toMatchObject({ include: ["structure", "states", "annotations", "reports"] });
    late.resolve();
    await timelineIdle();
    expect(useStore.getState().timelineStatus).toBe("ready");
  });
});
