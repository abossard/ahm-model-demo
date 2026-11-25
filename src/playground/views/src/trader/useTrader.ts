import { PLANETS, type Notice, type ToolInput, type ToolOutput, type TraderScore, type TraderSnapshot } from "@playground/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { call, errorText, log, type KitApp } from "../kit";
import { modelContextText } from "./logic";

type TraderAction = "trader_buy" | "trader_sell" | "trader_travel" | "trader_refuel" | "trader_new_run";

export interface TraderState {
  snapshot: TraderSnapshot;
  notice: Notice | null;
  failure: string | null;
  busy: boolean;
  act<N extends TraderAction>(name: N, args: Omit<ToolInput<N>, "player">): Promise<void>;
}

// A run is one document in the store and only this View writes it, so there is no live loop: each action returns the whole run.
export function useTrader(app: KitApp, initial: ToolOutput<"trader_open">, player: ToolInput<"trader_open">["player"]): TraderState {
  const [snapshot, setSnapshot] = useState(initial.snapshot);
  const [notice, setNotice] = useState<Notice | null>(initial.notice);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const act = useCallback(async <N extends TraderAction>(name: N, args: Omit<ToolInput<N>, "player">) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const started = performance.now();
    try {
      const out = (await call(app, name, { ...args, player } as ToolInput<N>)) as ToolOutput<N>;
      setSnapshot(out.snapshot);
      setNotice(out.notice);
      setFailure(null);
      log.info("action", { tool: name, ms: Math.round(performance.now() - started), notice: out.notice?.code ?? null, version: out.snapshot.version });
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [app, player]);

  useEffect(() => {
    const here = PLANETS.find((p) => p.id === snapshot.view.location)?.name ?? snapshot.view.location;
    app.updateModelContext({ content: [{ type: "text", text: modelContextText(snapshot.view, here) }] })
      .catch((error: unknown) => log.warn("context_failed", { error: errorText(error) }));
  }, [app, snapshot.version, snapshot.view]);

  return { snapshot, notice, failure, busy, act };
}

export function useScores(app: KitApp, refreshKey: unknown): { scores: TraderScore[]; refresh(): void } {
  const [scores, setScores] = useState<TraderScore[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    call(app, "trader_scores", {})
      .then((out) => { if (live) setScores(out.scores); })
      .catch((error: unknown) => log.warn("scores_failed", { error: errorText(error) }));
    return () => { live = false; };
  }, [app, refreshKey, tick]);
  return { scores, refresh: () => setTick((n) => n + 1) };
}
