import { create } from "zustand";
import { authSlice, type AuthActions, type AuthState } from "./authSlice";
import { catalogSlice, type CatalogActions, type CatalogState } from "./catalogSlice";
import { entitySlice, type EntityActions, type EntityState } from "./entitySlice";
import { modelSlice, type ModelActions, type ModelState } from "./modelSlice";
import { reportSlice, type ReportActions, type ReportState } from "./reportSlice";
import { sessionsSlice, type SessionsActions, type SessionsState } from "./sessionsSlice";
import { tasksSlice, type TasksActions, type TasksState } from "./tasksSlice";
import { uiSlice, type UiActions, type UiState } from "./uiSlice";

export type State = AuthState &
  CatalogState &
  ModelState &
  EntityState &
  ReportState &
  SessionsState &
  TasksState &
  UiState;
export type Actions = AuthActions &
  CatalogActions &
  ModelActions &
  EntityActions &
  ReportActions &
  SessionsActions &
  TasksActions &
  UiActions;
export type Store = State & Actions;

export const useStore = create<Store>()((...args) => ({
  ...authSlice(...args),
  ...catalogSlice(...args),
  ...modelSlice(...args),
  ...entitySlice(...args),
  ...reportSlice(...args),
  ...sessionsSlice(...args),
  ...tasksSlice(...args),
  ...uiSlice(...args),
}));

/**
 * The store's functions, bound once. They never change, so calling one never subscribes a
 * component and needs no `useCallback`.
 */
export const actions = Object.fromEntries(
  Object.entries(useStore.getState()).filter(([, value]) => typeof value === "function"),
) as unknown as Actions;
