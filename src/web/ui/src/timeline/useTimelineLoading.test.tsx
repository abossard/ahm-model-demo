import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRef } from "../model/types";
import { buildFixture, topologyFixture, type TimelineFixture } from "../model/timelineFixture";
import type { TimelineResponse } from "../model/timeline";
import { allKeys, buildRows, type RowModel } from "../model/timelineRows";
import { DAY, HOUR, MINUTE, type View } from "../model/timelineScale";
import { tileOf } from "../model/timelineTiles";
import * as api from "../store/api";
import { useStore } from "../store/store";
import { cancelTimelineSignals, setTimelineCache, timelineBounds } from "../store/timelineSlice";
import type { LiveStatus } from "../store/liveSlice";
import { entitiesToLoad, useTimelineLoading } from "./useTimelineLoading";

vi.mock("../store/api");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-11T12:00:00Z");
const MODEL: ModelRef = { id: "/a", name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a", location: null, provisioningState: null };
const FIXTURE = buildFixture({ now: NOW, days: 5, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 2, signalsPerResource: 2 });
const SLOW_MS = 1500;
const VIEW: View = { t0: NOW - DAY, t1: NOW };
const signal = (name: string) => ({ name, displayName: name, kind: null, unit: null, refreshInterval: "PT5M", rules: { degraded: null, unhealthy: null, dynamic: false } });
const PARENTS = ["svc-1", "svc-2", "svc-3", "svc-4", "svc-5"];
/** One database that five services depend on: the same entity under five parents. */
const SHARED = topologyFixture(
  [
    { name: "shop", displayName: "Shop", parents: [], signals: [] },
    ...PARENTS.map((name) => ({ name, displayName: name, parents: ["shop"], signals: [] })),
    { name: "shared-db", displayName: "Shared database", parents: PARENTS, signals: [signal("cpu"), signal("queue")] },
  ],
  { now: NOW, days: 5 },
);

const rowsOf = (fixture: TimelineFixture): RowModel => buildRows({ entities: fixture.entities, order: "structure", open: new Set(allKeys(fixture.entities)), rank: () => 0 });
const rows = rowsOf(FIXTURE);
const signalRowsOf = (entity: string): readonly number[] => rows.rows.flatMap((row, index) => (row.kind === "signal" && row.entity === entity ? [index] : []));
const RESOURCES = [...new Set(rows.rows.flatMap((row) => (row.kind === "signal" ? [row.entity] : [])))];
const FIRST = RESOURCES[0] as string;
const SECOND = RESOURCES[1] as string;
/** The rows from the first signal lane of the first entity to the last lane of the entity: what is on screen. */
const showing = (...entities: string[]): readonly [number, number] => {
  const at = entities.flatMap(signalRowsOf);
  return [Math.min(...at), Math.max(...at) + 1];
};

function Probe({ model, range, view = VIEW, width = 1000 }: { readonly model: RowModel; readonly range: readonly [number, number]; readonly view?: View; readonly width?: number }): null {
  useTimelineLoading(model, range, timelineBounds(useStore((state) => state.timelineData), NOW), view, width);
  return null;
}

const abortion = (): DOMException => new DOMException("aborted", "AbortError");

/** The app reads for a while before it answers, and drops the answer when the browser gives up on the request. */
function serve(fixture: TimelineFixture = FIXTURE): void {
  vi.mocked(api.fetchTimeline).mockImplementation((_selection, query, abort) => {
    const answer = (): TimelineResponse => fixture.answer({ from: query.from, to: query.to, include: query.include, entities: query.entities ?? [], signals: query.signals ?? [], resolution: query.resolution ?? 0 });
    if (!query.include.includes("signals")) return Promise.resolve(answer());
    return new Promise<TimelineResponse>((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer()), SLOW_MS);
      abort?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(abortion());
      });
    });
  });
}

type Call = readonly [unknown, api.TimelineQuery, AbortSignal | undefined];
const calls = (): readonly Call[] => vi.mocked(api.fetchTimeline).mock.calls as unknown as readonly Call[];
const signalCalls = (): readonly Call[] => calls().filter((call) => call[1].include.includes("signals"));
const overviewCalls = (): number => calls().filter((call) => !call[1].include.includes("signals")).length;
const advance = (ms: number): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("useTimelineLoading", () => {
  let host: HTMLDivElement;
  let root: Root;
  const show = (range: readonly [number, number], props: { model?: RowModel; view?: View; width?: number } = {}): Promise<void> =>
    act(async () => root.render(<Probe model={props.model ?? rows} range={range} {...(props.view ? { view: props.view } : {})} {...(props.width ? { width: props.width } : {})} />));
  const live = (status: LiveStatus): Promise<void> => act(async () => useStore.setState({ liveStatus: status }));

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    cancelTimelineSignals();
    setTimelineCache(null);
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({ selected: MODEL, timelineView: VIEW, timelineOpen: true, liveStatus: "live" });
    serve();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("reads the overview when it opens, at once", async () => {
    await show([0, 0]);
    await advance(10);

    expect(overviewCalls()).toBeGreaterThan(0);
    expect(useStore.getState().timelineStatus).toBe("ready");
    expect(signalCalls()).toEqual([]);
  });

  it("asks once for each lane that shows, and leaves a slow request alone while a lane is added", async () => {
    await show(showing(FIRST));
    await advance(300);
    expect(signalCalls().map((call) => call[1].entities)).toEqual([[FIRST]]);

    await show(showing(FIRST, SECOND));
    await advance(3000);

    expect(signalCalls().map((call) => call[1].entities)).toEqual([[FIRST], [SECOND]]);
    expect(signalCalls().filter((call) => call[2]?.aborted)).toEqual([]);
    expect(useStore.getState().timelineLoading).toEqual([]);
  });

  it("cancels a request only when none of its entities shows any more", async () => {
    await show(showing(FIRST));
    await advance(300);
    const [first] = signalCalls();

    await show(showing(SECOND));
    await advance(400);

    expect(first?.[2]?.aborted).toBe(true);
    expect(signalCalls().map((call) => call[1].entities)).toEqual([[FIRST], [SECOND]]);
    await advance(3000);
    expect(signalCalls()).toHaveLength(2);
  });

  it("an entity that shows under five parents is asked for once, held once and found by every one of its rows", async () => {
    serve(SHARED);
    const shared = rowsOf(SHARED);
    const lanes = shared.rows.filter((row) => row.kind === "signal" && row.entity === "shared-db");

    await show([0, shared.rows.length], { model: shared });
    await advance(3000);

    expect(lanes).toHaveLength(5 * 2);
    expect(entitiesToLoad(shared, [0, shared.rows.length])).toEqual(["shared-db"]);
    expect(signalCalls().map((call) => call[1].entities)).toEqual([["shared-db"]]);
    expect(Object.keys(useStore.getState().timelineSeries.series)).toHaveLength(2);
    expect(Object.keys(useStore.getState().timelineData.series)).toHaveLength(2);
  });

  it("a view that is still moving is told once it rests", async () => {
    await show(showing(FIRST));
    await advance(3000);
    const before = signalCalls().length;
    // The viewer moved away from now: the window no longer follows it.
    await act(async () => useStore.setState({ timelineFollow: false }));

    for (const days of [2, 3, 4]) {
      await show(showing(FIRST), { view: { t0: NOW - (days + 1) * DAY, t1: NOW - days * DAY } });
      await advance(100);
    }
    await advance(3000);

    expect(signalCalls().slice(before).map((call) => [call[1].from, call[1].to])).toEqual([[tileOf(NOW - 5.25 * DAY, DAY) * DAY, (tileOf(NOW - 3.75 * DAY, DAY) + 1) * DAY]]);
  });

  it.each([
    { name: "a wide plot reads every point of a week", width: 3000, resolution: 0 },
    { name: "a plot of a thousand pixels reads a week in slots of 15 minutes", width: 1000, resolution: 900 },
    { name: "a narrow plot reads a week in slots of an hour", width: 250, resolution: 3600 },
  ])("$name", async ({ width, resolution }) => {
    await show(showing(FIRST), { view: { t0: NOW - 7 * DAY, t1: NOW }, width });
    await advance(3000);

    expect(signalCalls().map((call) => call[1].resolution ?? 0)).toEqual([resolution]);
  });

  it("a selected moment reads the raw day around it for the lanes and the selected entity", async () => {
    await show([0, 0]);
    await advance(300);
    const moment = NOW - 3 * DAY;

    await act(async () => useStore.setState({ timelinePinned: moment, selectedName: SECOND }));
    await advance(3000);

    expect(signalCalls().map((call) => [call[1].entities, call[1].from, call[1].resolution ?? 0])).toEqual([[[SECOND], tileOf(moment, DAY) * DAY, 0]]);
  });

  describe("the tiles that are still open", () => {
    it.each([
      { status: "live", minutes: 5, reads: 0 },
      { status: "polling", minutes: 5, reads: 5 },
      { status: "off", minutes: 3, reads: 3 },
    ] as const)("are read $reads times in $minutes minutes while the stream is $status", async ({ status, minutes, reads }) => {
      await live(status);
      await show(showing(FIRST));
      await advance(30_000);
      const before = overviewCalls();

      await advance(minutes * MINUTE);

      expect(overviewCalls() - before).toBe(reads);
      expect(calls().slice(-1)[0]?.[1].from).toBeGreaterThanOrEqual(tileOf(NOW, 7 * DAY) * 7 * DAY);
    });

    it("are read again once when the stream comes back, and not for a stream that was never lost", async () => {
      await show(showing(FIRST));
      await live("live");
      await advance(10);
      const before = overviewCalls();

      await live("reconnecting");
      expect(overviewCalls()).toBe(before);
      await live("live");
      await advance(10);
      expect(overviewCalls()).toBe(before + 1);

      await advance(5 * MINUTE);
      expect(overviewCalls()).toBe(before + 1);
    });
  });

  it("a window that follows now is read up to the clock's now, whatever the newest instant held is", async () => {
    await show(showing(FIRST), { view: { t0: NOW - 3 * DAY - DAY, t1: NOW - 3 * DAY } });
    await advance(3000);

    expect(signalCalls().map((call) => [call[1].from, call[1].to])).toEqual([[(tileOf(NOW, DAY) - 1) * DAY, (tileOf(NOW, DAY) + 1) * DAY]]);
  });

  it("another model starts from nothing", async () => {
    await show(showing(FIRST));
    await advance(3000);

    await act(async () => useStore.setState({ selected: { ...MODEL, name: "hm-b" } }));
    await advance(10);

    expect(calls().slice(-1)[0]?.[0]).toMatchObject({ name: "hm-b" });
    expect(Object.keys(useStore.getState().timelineSeries.series)).toEqual([]);
    void HOUR;
  });
});
