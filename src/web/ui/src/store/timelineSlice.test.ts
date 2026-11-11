import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, ModelRef } from "../model/types";
import { buildFixture } from "../model/timelineFixture";
import { seriesKey, type TimelineResponse } from "../model/timeline";
import { allKeys, entityKey, rootKeys } from "../model/timelineRows";
import { DAY, HOUR } from "../model/timelineScale";
import * as api from "./api";
import { SIGNALS_PER_REQUEST, TIMELINE_MAX_HEIGHT, TIMELINE_MIN_HEIGHT, cancelTimelineSignals, historyStart, setOverviewCache } from "./timelineSlice";
import type { OverviewCache } from "../timeline/overviewCache";
import { actions, useStore } from "./store";

vi.mock("./api");

const NOW = Date.parse("2026-11-11T12:00:00Z");
const MODEL: ModelRef = { id: "/a", name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a", location: null, provisioningState: null };
const FIXTURE = buildFixture({ now: NOW, days: 5, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 2, signalsPerResource: 2 });
const FAILURE: ApiError = { code: "http_error", message: "Request failed with status 503.", retryable: true, operationId: null };

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The service answers from the fixture: the requested window, the requested entities. */
function serve(): void {
  vi.mocked(api.fetchTimeline).mockImplementation(async (_selection, query) =>
    query.include.includes("signals")
      ? FIXTURE.signals(query.entities ?? [], query.from, query.to)
      : FIXTURE.overview(query.from, query.to),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  cancelTimelineSignals();
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ selected: MODEL });
});

describe("opening and the link", () => {
  it.each([
    { search: "", open: false, view: null },
    { search: "?timeline=1", open: true, view: null },
    { search: "?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z", open: true, view: { t0: Date.parse("2026-11-10T10:00:00Z"), t1: Date.parse("2026-11-10T12:00:00Z") } },
  ])("reads $search", ({ search, open, view }) => {
    actions.initializeTimeline(search);

    expect(useStore.getState().timelineOpen).toBe(open);
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

describe("loadTimelineOverview", () => {
  it("opens the rows of the roots the first time the model is read, and then keeps what the viewer opened", async () => {
    serve();
    await actions.loadTimelineOverview();

    expect(useStore.getState().timelineExpanded).toEqual(rootKeys(FIXTURE.entities));

    actions.collapseTimelineEntities();
    await actions.loadTimelineOverview();

    expect(useStore.getState().timelineExpanded).toEqual([]);
  });

  it("reads the whole retention for the selected model and shows the last day", async () => {
    serve();

    await actions.loadTimelineOverview();

    const state = useStore.getState();
    const [selection, query] = vi.mocked(api.fetchTimeline).mock.calls[0] ?? [];
    expect(selection).toBe(MODEL);
    expect(query).toMatchObject({ from: NOW - 30 * DAY, to: NOW, include: ["states", "annotations", "reports"] });
    expect(state.timelineStatus).toBe("ready");
    expect(state.timelineData.entities.length).toBe(FIXTURE.entities.length);
    expect(state.timelineView).toEqual({ t0: NOW - DAY, t1: NOW });
    expect(Object.keys(state.timelineData.states)).toHaveLength(FIXTURE.entities.length);
  });

  it("keeps a view a link named", async () => {
    serve();
    const view = { t0: NOW - 3 * HOUR, t1: NOW - HOUR };
    actions.initializeTimeline(`?timeline=1&from=${view.t0}&to=${view.t1}`);

    await actions.loadTimelineOverview();

    expect(useStore.getState().timelineView).toEqual(view);
  });

  it("a failure before anything is shown is a failed status with its error", async () => {
    vi.mocked(api.fetchTimeline).mockRejectedValue(FAILURE);

    await actions.loadTimelineOverview();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "failed", timelineError: FAILURE });
  });

  it("a failed refresh keeps what is on screen and says why", async () => {
    serve();
    await actions.loadTimelineOverview();
    vi.mocked(api.fetchTimeline).mockRejectedValue(FAILURE);

    await actions.loadTimelineOverview();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "ready", timelineError: FAILURE });
    expect(useStore.getState().timelineData.entities.length).toBeGreaterThan(0);
  });

  it("a second load cancels the first", async () => {
    const first = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValueOnce(first.promise);
    serve();
    const slow = actions.loadTimelineOverview();
    const signal = vi.mocked(api.fetchTimeline).mock.calls[0]?.[2];

    const fast = actions.loadTimelineOverview();
    first.reject(new DOMException("aborted", "AbortError"));
    await Promise.all([slow, fast]);

    expect(signal?.aborted).toBe(true);
    expect(useStore.getState().timelineStatus).toBe("ready");
  });

  it("an answer that arrives after a reset is dropped", async () => {
    const late = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValueOnce(late.promise);
    const load = actions.loadTimelineOverview();

    actions.resetTimeline();
    late.resolve(FIXTURE.overview(NOW - DAY, NOW));
    await load;

    expect(useStore.getState().timelineStatus).toBe("idle");
    expect(useStore.getState().timelineData.entities).toEqual([]);
  });

  it("an answer for a model that is no longer selected is dropped", async () => {
    const late = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValueOnce(late.promise);
    const load = actions.loadTimelineOverview();

    useStore.setState({ selected: { ...MODEL, name: "hm-b" } });
    late.resolve(FIXTURE.overview(NOW - DAY, NOW));
    await load;

    expect(useStore.getState().timelineData.entities).toEqual([]);
  });
});

describe("loadTimelineSignals", () => {
  const RESOURCE = FIXTURE.entities.find((entity) => entity.signals.length > 0)!;

  async function overview(): Promise<void> {
    serve();
    await actions.loadTimelineOverview();
    vi.mocked(api.fetchTimeline).mockClear();
  }

  it("reads the signals of the entities and holds their points", async () => {
    await overview();

    const load = actions.loadTimelineSignals([RESOURCE.name], NOW - 6 * HOUR, NOW);
    expect(useStore.getState().timelineLoading).toEqual([RESOURCE.name]);
    await load;

    const held = useStore.getState().timelineData.series[seriesKey(RESOURCE.name, RESOURCE.signals[0]!.name)];
    expect(held?.points.length).toBeGreaterThan(50);
    expect(held?.covered).toEqual([{ from: NOW - 6 * HOUR, to: NOW }]);
    expect(useStore.getState().timelineLoading).toEqual([]);
    expect(vi.mocked(api.fetchTimeline).mock.calls[0]?.[1]).toMatchObject({ include: ["signals"], entities: [RESOURCE.name] });
  });

  it("splits a long list into requests under the service's limit", async () => {
    await overview();
    const many = Array.from({ length: 3 }, (_, i) => ({ ...RESOURCE, name: `big-${i}`, signals: Array.from({ length: 60 }, () => RESOURCE.signals[0]!) }));
    useStore.setState((state) => ({ timelineData: { ...state.timelineData, entities: [...state.timelineData.entities, ...many] } }));

    await actions.loadTimelineSignals(many.map((entity) => entity.name), NOW - HOUR, NOW);

    const asked = vi.mocked(api.fetchTimeline).mock.calls.map((call) => call[1].entities);
    expect(asked).toEqual([["big-0"], ["big-1"], ["big-2"]]);
    expect(60 * 2).toBeGreaterThan(SIGNALS_PER_REQUEST);
  });

  it("a failed request marks its series so they are not asked for again, and a retry clears the mark", async () => {
    await overview();
    vi.mocked(api.fetchTimeline).mockRejectedValue(FAILURE);

    await actions.loadTimelineSignals([RESOURCE.name], NOW - HOUR, NOW);

    const key = seriesKey(RESOURCE.name, RESOURCE.signals[0]!.name);
    expect(useStore.getState().timelineData.series[key]?.error?.code).toBe("http_error");
    expect(useStore.getState().timelineError).toEqual(FAILURE);
    expect(useStore.getState().timelineLoading).toEqual([]);

    actions.retryTimelineSignals([RESOURCE.name]);

    expect(useStore.getState().timelineData.series[key]?.error).toBeNull();
  });

  it("cancelling aborts what is in flight and leaves no mark", async () => {
    await overview();
    const never = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValue(never.promise);
    const load = actions.loadTimelineSignals([RESOURCE.name], NOW - HOUR, NOW);
    const signal = vi.mocked(api.fetchTimeline).mock.calls[0]?.[2];

    cancelTimelineSignals();
    never.reject(new DOMException("aborted", "AbortError"));
    await load;

    expect(signal?.aborted).toBe(true);
    expect(useStore.getState().timelineError).toBeNull();
    expect(useStore.getState().timelineLoading).toEqual([]);
  });

  it("refresh reads the overview and the newest minutes of the open lanes", async () => {
    await overview();
    const keys = allKeys(FIXTURE.entities).filter((key) => key.endsWith(RESOURCE.name));
    expect(keys.length).toBeGreaterThan(0);
    actions.expandTimelineEntities(keys);

    await actions.refreshTimeline();
    await flush();

    const calls = vi.mocked(api.fetchTimeline).mock.calls.map((call) => call[1]);
    expect(calls[0]?.include).toEqual(["states", "annotations", "reports"]);
    expect(calls[1]).toMatchObject({ include: ["signals"], entities: [RESOURCE.name], to: NOW });
    expect((calls[1]?.to ?? 0) - (calls[1]?.from ?? 0)).toBeLessThanOrEqual(20 * 60_000);
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

  it("sets the order and pins and unpins a moment", () => {
    actions.setTimelineOrder("worst");
    actions.pinTimeline(123);
    expect(useStore.getState()).toMatchObject({ timelineOrder: "worst", timelinePinned: 123 });
    actions.pinTimeline(null);
    expect(useStore.getState().timelinePinned).toBeNull();
  });

  it("clamps a view to the history and ignores one that did not change", async () => {
    serve();
    await actions.loadTimelineOverview();

    actions.setTimelineView({ t0: NOW - 100 * DAY, t1: NOW + DAY });
    const wide = useStore.getState().timelineView;
    expect(wide?.t1).toBe(NOW);
    expect(wide?.t0).toBe(historyStart(useStore.getState().timelineData));

    const before = useStore.getState();
    actions.setTimelineView({ ...wide! });
    expect(useStore.getState().timelineView).toBe(before.timelineView);
  });

  it("resetting forgets the data, the lanes and the pin", async () => {
    serve();
    await actions.loadTimelineOverview();
    actions.expandTimelineEntities(["a"]);
    actions.pinTimeline(5);

    actions.resetTimeline();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "idle", timelineExpanded: [], timelinePinned: null });
    expect(useStore.getState().timelineData.entities).toEqual([]);
  });

  it("history starts at the first transition seen, a little before it", async () => {
    serve();
    await actions.loadTimelineOverview();

    const start = historyStart(useStore.getState().timelineData);

    expect(start).toBeGreaterThanOrEqual(useStore.getState().timelineData.floor);
    expect(start).toBeLessThan(NOW - 4 * DAY);
  });
});


describe("live mode and the browser cache", () => {
  const cache = (stored: TimelineResponse | null): { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } =>
    ({ read: vi.fn().mockResolvedValue(stored), write: vi.fn() });
  afterEach(() => setOverviewCache(null));

  it("follows now by default, a link names a following window by its length, and moving away stops following", async () => {
    expect(useStore.getState().timelineFollow).toBe(true);
    actions.initializeTimeline("?timeline=1&live=1&span=3600000");
    expect(useStore.getState().timelineView).toEqual({ t0: NOW - HOUR, t1: NOW });
    expect(useStore.getState().timelineFollow).toBe(true);
    serve();
    await actions.loadTimelineOverview();

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
    await actions.loadTimelineOverview();

    actions.setTimelineView({ t0: NOW - 6 * HOUR, t1: NOW });

    expect(useStore.getState().timelineFollow).toBe(true);
  });

  it("a link without a live window is not followed", () => {
    actions.initializeTimeline("?timeline=1&from=2026-11-10T10:00:00Z&to=2026-11-10T12:00:00Z");

    expect(useStore.getState().timelineFollow).toBe(false);
  });

  it("paints what the browser kept before the network answers, then replaces it and starts again from now", async () => {
    const old = FIXTURE.overview(NOW - 3 * DAY - DAY, NOW - 3 * DAY);
    const kept = cache(old);
    setOverviewCache(kept as unknown as OverviewCache);
    const answer = pending<TimelineResponse>();
    vi.mocked(api.fetchTimeline).mockReturnValueOnce(answer.promise);

    const load = actions.loadTimelineOverview();
    await flush();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "ready", timelineStale: true });
    expect(useStore.getState().timelineData.entities.length).toBe(FIXTURE.entities.length);
    answer.resolve(FIXTURE.overview(NOW - 30 * DAY, NOW));
    await load;

    const state = useStore.getState();
    expect(state.timelineStale).toBe(false);
    expect(state.timelineView).toEqual({ t0: NOW - DAY, t1: NOW });
    expect(kept.read).toHaveBeenCalledWith("sub-a/rg-a/hm-a");
    expect(kept.write).toHaveBeenCalledWith("sub-a/rg-a/hm-a", expect.objectContaining({ model: expect.any(String) }));
  });

  it("a cache with nothing in it changes nothing, and a network that answers first wins", async () => {
    setOverviewCache(cache(null) as unknown as OverviewCache);
    serve();

    await actions.loadTimelineOverview();
    await flush();

    expect(useStore.getState()).toMatchObject({ timelineStatus: "ready", timelineStale: false });

    const late = cache(FIXTURE.overview(NOW - 5 * DAY, NOW - 4 * DAY));
    late.read.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(FIXTURE.overview(NOW - 5 * DAY, NOW - 4 * DAY)), 50)));
    setOverviewCache(late as unknown as OverviewCache);
    actions.resetTimeline();
    serve();
    await actions.loadTimelineOverview();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(useStore.getState().timelineStale).toBe(false);
    expect(useStore.getState().timelineView).toEqual({ t0: NOW - DAY, t1: NOW });
  });
});
