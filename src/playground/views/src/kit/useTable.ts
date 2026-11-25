import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveSnapshot, Notice, Player, ToolInput, ToolName } from "@playground/contracts";
import { call, type KitApp } from "./call";
import { followTable, takeSnapshot } from "./live";
import { errorText, log } from "./log";
import { withTransition } from "./transition";

const NOTICE_MS = 6000;

interface TableState<S> {
  snapshot: S | null;
  notice: Notice | null;
}

export interface Table<S> {
  snapshot: S | null;
  notice: Notice | null;
  // The server could not serve the last action. Not a rule that did not apply.
  error: string | null;
  busy: boolean;
  offline: boolean;
  act<N extends ToolName>(name: N, args: ToolInput<N>): Promise<void>;
  // Stops following the table and forgets it. The View shows its lobby again.
  leave(): void;
}

// Everything a game View needs of the server: the snapshot, the notice of the last action, and live turns.
export function useTable<S extends LiveSnapshot>(app: KitApp, player: Player, initial: S | null): Table<S> {
  const [state, setState] = useState<TableState<S>>({ snapshot: initial, notice: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const [offline, setOffline] = useState(false);
  const latest = useRef<S | null>(initial);
  latest.current = state.snapshot;
  const tableId = state.snapshot?.tableId ?? null;

  const take = useCallback((snapshot: S | null, notice: Notice | null) => {
    // The one place every new snapshot is applied, pushed by wait_for_change or answered to the player's own action.
    withTransition(() => setState((current) => ({ snapshot: takeSnapshot(current.snapshot, snapshot), notice })));
  }, []);

  useEffect(() => {
    if (!tableId) return;
    const stop = new AbortController();
    void followTable({
      app,
      player,
      tableId,
      version: () => latest.current?.version ?? -1,
      signal: stop.signal,
      onChange: (snapshot, notice) => take(snapshot as S | null, notice),
      onOffline: setOffline,
    });
    return () => stop.abort();
  }, [app, player.id, tableId, take]);

  useEffect(() => {
    const game = latest.current?.game;
    const text = tableId ? `Viewing the ${game} table ${tableId}.` : "In the lobby. No table open.";
    app.updateModelContext({ content: [{ type: "text", text }], structuredContent: { tableId } })
      .catch((reason) => log.warn("updateModelContext failed", { error: errorText(reason) }));
  }, [app, tableId]);

  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(() => setState((current) => ({ ...current, notice: null })), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.notice]);

  const act = useCallback(async <N extends ToolName>(name: N, args: ToolInput<N>) => {
    setBusy((n) => n + 1);
    setError(null);
    try {
      const out = (await call(app, name, args)) as { snapshot?: S | null; notice?: Notice | null };
      take(out.snapshot ?? null, out.notice ?? null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy((n) => n - 1);
    }
  }, [app, take]);

  const leave = useCallback(() => {
    setState({ snapshot: null, notice: null });
    setError(null);
  }, []);

  return { snapshot: state.snapshot, notice: state.notice, error, busy: busy > 0, offline, act, leave };
}
