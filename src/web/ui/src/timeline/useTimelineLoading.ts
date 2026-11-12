import { useEffect, useRef } from "react";
import type { RowModel } from "../model/timelineRows";
import { DAY, type Bounds, type View } from "../model/timelineScale";
import { actions, useStore } from "../store/store";
import { cancelTimelineSignals } from "../store/timelineSlice";

const SETTLE_MS = 220;
const REFRESH_MS = 60_000;

/** The entities whose signal lanes are on screen or one screenful away: only those are worth asking Azure for. */
export function entitiesToLoad(rows: RowModel, range: readonly [number, number]): readonly string[] {
  const names = new Set<string>();
  for (let i = range[0]; i < Math.min(range[1], rows.rows.length); i += 1) {
    const row = rows.rows[i];
    if (row?.kind === "signal") names.add(row.entity);
  }
  return [...names];
}

/** The width of the plot when the caller does not give it: the canvas of the timeline, or the window's. */
function plotWidth(): number {
  return document.querySelector<HTMLCanvasElement>('#timeline-panel canvas, [data-testid="tl-canvas"]')?.clientWidth || window.innerWidth;
}

/** Reads the open tiles again and moves a window that ends at now along with what they brought. */
function reread(shown: View | null, heldUntil: number): void {
  const following = shown !== null && shown.t1 >= heldUntil - 2 * 60_000;
  void actions.refreshTimeline().then(() => {
    const next = useStore.getState().timelineData.now;
    if (following && shown !== null && next > shown.t1) actions.setTimelineView({ t0: shown.t0 + (next - shown.t1), t1: next });
  });
}

/**
 * Tells the loader what the timeline shows: the window, the width that decides how fine the series have to be, the
 * lanes on screen and the selected moment. The loader reads what is missing of it. A view that moves is told once it
 * settles. While the live stream runs its deltas keep what is held current; the open tiles are read again every minute
 * when it does not, and once the stream is back.
 *
 * `width` is the width of the plot in pixels; without it the timeline's canvas is measured.
 */
export function useTimelineLoading(rows: RowModel, range: readonly [number, number], _bounds: Bounds, view: View | null, width?: number): void {
  const selectedKey = useStore((state) => (state.selected ? `${state.selected.subscriptionId}/${state.selected.resourceGroup}/${state.selected.name}` : ""));
  const owner = useStore((state) => (state.account ? `${state.account.tenantId}/${state.account.username}` : ""));
  const liveStatus = useStore((state) => state.liveStatus);
  const follow = useStore((state) => state.timelineFollow);
  const moment = useStore((state) => state.timelinePinned);
  const watched = useStore((state) => state.timelineWatched);
  const selectedName = useStore((state) => state.selectedName);
  const latest = useRef({ view });
  latest.current = { view };
  const stream = useRef<"never" | "live" | "lost">("never");

  useEffect(() => {
    if (selectedKey === "") return;
    actions.resetTimeline();
    return () => cancelTimelineSignals();
  }, [selectedKey, owner]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const state = useStore.getState();
      if (state.liveStatus === "live" && state.timelineStatus === "ready") return;
      reread(latest.current.view, state.timelineData.now);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const before = stream.current;
    stream.current = liveStatus === "live" ? "live" : before === "never" ? "never" : "lost";
    // Deltas that came while the stream was down are lost: read what they would have said.
    const state = useStore.getState();
    if (before === "lost" && liveStatus === "live" && state.timelineStatus === "ready") reread(latest.current.view, state.timelineData.now);
  }, [liveStatus]);

  const lanes = entitiesToLoad(rows, range).join("\u0001");
  const watching = [...new Set([...watched, ...(selectedName === null ? [] : [selectedName])])].join("\u0001");
  const t0 = view?.t0 ?? null;
  const t1 = view?.t1 ?? null;
  const told = useRef("");
  useEffect(() => {
    if (selectedKey === "") return;
    const tell = (): void => {
      const now = Date.now();
      // A window that follows now ends at the clock's now, not at the newest instant held: what the browser kept may be old.
      const end = t1 === null || follow ? Math.max(t1 ?? 0, now) : t1;
      const span = t0 === null || t1 === null ? DAY : t1 - t0;
      actions.wantTimeline({
        view: { from: end - span, to: end },
        width: width ?? plotWidth(),
        lanes: lanes === "" ? [] : lanes.split("\u0001"),
        moment,
        watched: watching === "" ? [] : watching.split("\u0001"),
      });
    };
    // The first telling for a model starts the overview at once; after that a view that is still moving is not worth a request.
    if (told.current !== `${selectedKey} ${owner}`) {
      told.current = `${selectedKey} ${owner}`;
      tell();
      return;
    }
    const timer = window.setTimeout(tell, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [selectedKey, owner, t0, t1, follow, lanes, moment, watching, width]);
}
