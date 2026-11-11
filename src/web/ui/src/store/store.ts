import { create } from "zustand";
import { authSlice, type AuthActions, type AuthState } from "./authSlice";
import { catalogSlice, type CatalogActions, type CatalogState } from "./catalogSlice";
import { entitySlice, type EntityActions, type EntityState } from "./entitySlice";
import { liveSlice, type LiveActions, type LiveState } from "./liveSlice";
import { modelSlice, type ModelActions, type ModelState } from "./modelSlice";
import { reportSlice, type ReportActions, type ReportState } from "./reportSlice";
import { sessionsSlice, type SessionsActions, type SessionsState } from "./sessionsSlice";
import { tasksSlice, type TasksActions, type TasksState } from "./tasksSlice";
import { timelineSlice, type TimelineActions, type TimelineState } from "./timelineSlice";
import { uiSlice, type UiActions, type UiState } from "./uiSlice";

export type State = AuthState &
  CatalogState &
  LiveState &
  ModelState &
  EntityState &
  ReportState &
  SessionsState &
  TasksState &
  TimelineState &
  UiState;
export type Actions = AuthActions &
  CatalogActions &
  LiveActions &
  ModelActions &
  EntityActions &
  ReportActions &
  SessionsActions &
  TasksActions &
  TimelineActions &
  UiActions;
export type Store = State & Actions;

/**
 * What takes room from the graph: the width of the Sessions panel and the height of the timeline under it. A view fits
 * the graph again when it changes. Full screen covers the graph without resizing it, so it is no part of it.
 */
export const canvasFrame = (state: Store): string =>
  `${state.workspaceOpen ? state.workspaceWidth : 0}x${state.timelineOpen ? state.timelineHeight : 0}`;

export const useStore = create<Store>()((...args) => ({
  ...authSlice(...args),
  ...catalogSlice(...args),
  ...liveSlice(...args),
  ...modelSlice(...args),
  ...entitySlice(...args),
  ...reportSlice(...args),
  ...sessionsSlice(...args),
  ...tasksSlice(...args),
  ...timelineSlice(...args),
  ...uiSlice(...args),
}));

/**
 * The store's functions, bound once. They never change, so calling one never subscribes a
 * component and needs no `useCallback`.
 */
export const actions = Object.fromEntries(
  Object.entries(useStore.getState()).filter(([, value]) => typeof value === "function"),
) as unknown as Actions;
