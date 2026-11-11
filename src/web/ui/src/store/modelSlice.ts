import type { StateCreator } from "zustand";
import type { ApiError, AsyncState, HealthModel } from "../model/types";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";

export interface ModelState {
  readonly model: AsyncState<HealthModel>;
  readonly lastObservedAt: string | null;
  readonly refreshing: boolean;
  /** Why the last reload failed while an earlier observation is still on screen; null otherwise. */
  readonly refreshError: ApiError | null;
}

export interface ModelActions {
  /** `fresh`: the app reads the model from Azure now (the Refresh button), not from what it keeps warm. */
  readonly loadHealthModel: (options?: { readonly fresh?: boolean }) => Promise<void>;
}

export const modelSlice: StateCreator<Store, [], [], ModelState & ModelActions> = (set, get) => ({
  model: IDLE,
  lastObservedAt: null,
  refreshing: false,
  refreshError: null,

  loadHealthModel: async (options) => {
    const { selected } = get();
    set((state) => ({
      refreshing: true,
      model: state.model.kind === "success" ? state.model : LOADING,
    }));
    const model = await settle(
      options?.fresh ? api.fetchHealthModel(selected, true) : api.fetchHealthModel(selected),
      "The health model could not be loaded.",
    );
    // A response for a model that is no longer selected must not replace the one on screen.
    if (get().selected !== selected) return;
    // A reload that fails keeps the last observation on screen, so a Task result open beside the graph keeps its marks.
    const shown = get().model;
    if (model.kind === "failure" && shown.kind === "success") {
      set({ refreshing: false, refreshError: model.error });
      return;
    }
    set({
      model,
      refreshing: false,
      refreshError: null,
      ...(model.kind === "success" ? { lastObservedAt: model.value.observedAt } : {}),
    });
  },
});
