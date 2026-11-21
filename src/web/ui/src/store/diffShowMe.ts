import { flushSync } from "react-dom";
import type { StoreApi } from "zustand";
import { sameModel } from "../model/selection";
import type { Task } from "../model/types";
import type { Store } from "./store";

type TaskIdentity = Pick<Task, "target"> & Partial<Pick<Task, "seq" | "sessionId">>;
export type ShowChange = (id: string) => Element | null;

/** Inspect only the open Task's saved diff. The change list owns its scroll position and expansion. */
export function openDiffPanel(
  store: Pick<StoreApi<Store>, "getState" | "subscribe">, task: TaskIdentity, id: string,
  signal: AbortSignal, showChange: ShowChange | undefined, clear: () => void,
): Element | null {
  const state = store.getState();
  const { diff } = state;
  if (signal.aborted || state.sessionId !== task.sessionId || state.taskSeq !== task.seq ||
      diff.kind !== "success" || !sameModel(diff.value.target, task.target) || !diff.value.changes.length) return null;

  if (id === "comparison") {
    flushSync(() => {
      state.setTimelineFullscreen(false);
      state.setWorkspaceTarget("graph");
      state.setCompare(true);
    });
    const target = document.querySelector("[data-show-me-comparison]");
    if (!target) {
      state.setWorkspaceTarget(null);
      state.setCompare(false);
      return null;
    }
    const unwatch = store.subscribe(next => {
      if (next.compare && next.workspaceTarget === "graph" && next.taskSeq === task.seq && next.sessionId === task.sessionId) return;
      clear();
      if (next.workspaceTarget === "graph") next.setWorkspaceTarget(null);
    });
    signal.addEventListener("abort", unwatch, { once: true });
    return target;
  }

  const change = id.startsWith("change/") ? id.slice("change/".length) : "";
  if (!showChange || !diff.value.changes.some(item => item.id === change)) return null;
  state.setWorkspaceTarget(null);
  return showChange(change);
}
