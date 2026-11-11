import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixture } from "../model/timelineFixture";
import { EMPTY_TIMELINE, mergeResponse, type TimelineResponse } from "../model/timeline";
import { allKeys, buildRows, type RowModel } from "../model/timelineRows";
import { DAY, MINUTE, type View } from "../model/timelineScale";
import * as api from "../store/api";
import { useStore } from "../store/store";
import { cancelTimelineSignals, timelineBounds } from "../store/timelineSlice";
import type { LiveStatus } from "../store/liveSlice";
import { useTimelineLoading } from "./useTimelineLoading";

vi.mock("../store/api");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-11T12:00:00Z");
const FIXTURE = buildFixture({ now: NOW, days: 5, flows: 1, componentsPerFlow: 1, resourcesPerComponent: 2, signalsPerResource: 2 });
const SLOW_MS = 1500;
const VIEW: View = { t0: NOW - DAY, t1: NOW };

const rows = buildRows({ entities: FIXTURE.entities, order: "structure", open: new Set(allKeys(FIXTURE.entities)), rank: () => 0 });
const signalRowsOf = (entity: string): readonly number[] => rows.rows.flatMap((row, index) => (row.kind === "signal" && row.entity === entity ? [index] : []));
const RESOURCES = [...new Set(rows.rows.flatMap((row) => (row.kind === "signal" ? [row.entity] : [])))];
const FIRST = RESOURCES[0] as string;
const SECOND = RESOURCES[1] as string;
/** The rows from the first signal lane of the first entity to the last lane of the entity: what is on screen. */
const showing = (...entities: string[]): readonly [number, number] => {
  const at = entities.flatMap(signalRowsOf);
  return [Math.min(...at), Math.max(...at) + 1];
};

function Probe({ model, range }: { readonly model: RowModel; readonly range: readonly [number, number] }): null {
  useTimelineLoading(model, range, timelineBounds(useStore((state) => state.timelineData), NOW), VIEW);
  return null;
}

const abortion = (): DOMException => new DOMException("aborted", "AbortError");

/** The service reads for a while before it answers, and drops the answer when the browser gives up on the request. */
function serve(): void {
  vi.mocked(api.fetchTimeline).mockImplementation((_selection, query, signal) => {
    if (!query.include.includes("signals")) return Promise.resolve(FIXTURE.overview(query.from, query.to));
    return new Promise<TimelineResponse>((resolve, reject) => {
      const timer = setTimeout(() => resolve(FIXTURE.signals(query.entities ?? [], query.from, query.to)), SLOW_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(abortion());
      });
    });
  });
}

const signalCalls = (): readonly (readonly [unknown, { readonly entities?: readonly string[] }, AbortSignal | undefined])[] =>
  vi.mocked(api.fetchTimeline).mock.calls.filter((call) => call[1].include.includes("signals")) as never;
const overviewCalls = (): number => vi.mocked(api.fetchTimeline).mock.calls.filter((call) => !call[1].include.includes("signals")).length;
const advance = (ms: number): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("useTimelineLoading", () => {
  let host: HTMLDivElement;
  let root: Root;
  const show = (range: readonly [number, number]): Promise<void> => act(async () => root.render(<Probe model={rows} range={range} />));
  const live = (status: LiveStatus): Promise<void> => act(async () => useStore.setState({ liveStatus: status }));

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    cancelTimelineSignals();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      timelineStatus: "ready",
      timelineData: mergeResponse(EMPTY_TIMELINE, FIXTURE.overview(NOW - 30 * DAY, NOW)),
      timelineView: VIEW,
      timelineOpen: true,
      liveStatus: "live",
    });
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

  it("asks once for each lane that shows, and leaves a slow request alone while a lane is added", async () => {
    await show(showing(FIRST));
    await advance(300);
    expect(signalCalls().map((call) => call[1].entities)).toEqual([[FIRST]]);

    await show(showing(FIRST, SECOND));
    await advance(5000);

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
    await advance(5000);
    expect(signalCalls()).toHaveLength(2);
  });

  describe("the overview", () => {
    it.each([
      { status: "live", minutes: 5, reads: 0 },
      { status: "polling", minutes: 5, reads: 5 },
      { status: "off", minutes: 3, reads: 3 },
    ] as const)("is read $reads times in $minutes minutes while the stream is $status", async ({ status, minutes, reads }) => {
      await live(status);
      await show(showing(FIRST));
      await advance(minutes * MINUTE);

      expect(overviewCalls()).toBe(reads);
    });

    it("is read again once when the stream comes back, and not for a stream that was never lost", async () => {
      await show(showing(FIRST));
      await live("live");
      expect(overviewCalls()).toBe(0);

      await live("reconnecting");
      expect(overviewCalls()).toBe(0);
      await live("live");
      await advance(10);
      expect(overviewCalls()).toBe(1);

      await advance(5 * MINUTE);
      expect(overviewCalls()).toBe(1);
    });
  });
});
