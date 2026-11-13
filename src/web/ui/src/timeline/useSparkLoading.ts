import { useEffect } from "react";
import { actions, useStore } from "../store/store";
import { cancelTimelineSignals } from "../store/timelineSlice";

const SEP = "\u0001";
/** A window that ends at now moves on: it is told again this often, and the loader reads a tile only when it begins a new one. */
const RETELL_MS = 60_000;

/**
 * Reads the series of the cards' sparklines while the timeline is closed. While it is open, its own loading reads them
 * with everything else. The reading stops when no card shows a sparkline, when the timeline opens and when the graph
 * that calls this is gone.
 */
export function useSparkLoading(): void {
  const selectedKey = useStore((state) => (state.selected ? `${state.selected.subscriptionId}/${state.selected.resourceGroup}/${state.selected.name}` : ""));
  const owner = useStore((state) => (state.account ? `${state.account.tenantId}/${state.account.username}` : ""));
  const open = useStore((state) => state.timelineOpen);
  const sparks = useStore((state) => state.timelineSparks).join(SEP);
  const active = !open && selectedKey !== "" && sparks !== "";

  useEffect(() => {
    if (!active) return;
    return () => cancelTimelineSignals();
  }, [active, selectedKey, owner]);

  useEffect(() => {
    if (!active) return;
    actions.wantSparks();
    const timer = window.setInterval(() => actions.wantSparks(), RETELL_MS);
    return () => window.clearInterval(timer);
  }, [active, selectedKey, owner, sparks]);
}
