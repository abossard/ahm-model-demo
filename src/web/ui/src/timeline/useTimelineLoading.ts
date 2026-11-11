import { useEffect, useRef } from "react";
import { planSignals } from "../model/timelineIncidents";
import type { RowModel } from "../model/timelineRows";
import type { TimelineData } from "../model/timeline";
import { padView, type Bounds, type View } from "../model/timelineScale";
import { actions, useStore } from "../store/store";
import { cancelTimelineSignals, cancelUnwantedSignals } from "../store/timelineSlice";

const SIGNAL_DEBOUNCE_MS = 220;
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

/** Reads the overview and the newest minutes of the open lanes again, and moves a window that ends at now along with them. */
function reread(shown: View | null, held: TimelineData): void {
  const following = shown !== null && shown.t1 >= held.now - 2 * 60_000;
  void actions.refreshTimeline().then(() => {
    const next = useStore.getState().timelineData.now;
    if (following && shown !== null && next > shown.t1) actions.setTimelineView({ t0: shown.t0 + (next - shown.t1), t1: next });
  });
}

/**
 * Reads the overview when the timeline opens or the model changes, asks for the signals of the lanes that show as the
 * view settles (debounced, and a request for lanes that no longer show is cancelled). While the live stream runs its
 * deltas keep what is read current; the overview is read again every minute when it does not, and once the stream is back.
 */
export function useTimelineLoading(rows: RowModel, range: readonly [number, number], bounds: Bounds, view: View | null): void {
  const selectedKey = useStore((state) => (state.selected ? `${state.selected.subscriptionId}/${state.selected.resourceGroup}/${state.selected.name}` : ""));
  const data = useStore((state) => state.timelineData);
  const status = useStore((state) => state.timelineStatus);
  const loading = useStore((state) => state.timelineLoading);
  const liveStatus = useStore((state) => state.liveStatus);
  const latest = useRef({ view, data, bounds });
  latest.current = { view, data, bounds };
  const stream = useRef<"never" | "live" | "lost">("never");

  useEffect(() => {
    if (selectedKey === "") return;
    actions.resetTimeline();
    void actions.loadTimelineOverview();
    return () => cancelTimelineSignals();
  }, [selectedKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const state = useStore.getState();
      if (state.liveStatus === "live" && state.timelineStatus === "ready") return;
      reread(latest.current.view, latest.current.data);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const before = stream.current;
    stream.current = liveStatus === "live" ? "live" : before === "never" ? "never" : "lost";
    // Deltas that came while the stream was down are lost: read what they would have said.
    if (before === "lost" && liveStatus === "live" && useStore.getState().timelineStatus === "ready") reread(latest.current.view, latest.current.data);
  }, [liveStatus]);

  const names = entitiesToLoad(rows, range).join("\u0001");
  useEffect(() => {
    if (status !== "ready" || view === null) return;
    const timer = window.setTimeout(() => {
      const shown = names === "" ? [] : names.split("\u0001");
      cancelUnwantedSignals(new Set(shown));
      const plan = planSignals(data, shown.filter((name) => !loading.includes(name)), wantedSpan(view, bounds));
      if (plan === null) return;
      void actions.loadTimelineSignals(plan.entities, plan.span.from, plan.span.to);
    }, SIGNAL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [status, view, data, names, loading, bounds]);
}

/** The view and a quarter more either side, so a small pan does not ask again. */
export function wantedSpan(view: View, bounds: Bounds): { readonly from: number; readonly to: number } {
  const padded = padView(view.t0, view.t1, bounds);
  return { from: padded.t0, to: padded.t1 };
}
