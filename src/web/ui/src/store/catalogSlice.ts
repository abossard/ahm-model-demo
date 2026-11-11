import type { StateCreator } from "zustand";
import type { AsyncState, ModelCatalog, ModelRef, ModelSelection } from "../model/types";
import { selectionFromSearch } from "../model/selection";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";

export interface CatalogState {
  readonly catalog: AsyncState<ModelCatalog>;
  readonly selected: ModelRef | null;
  readonly unavailableSelection: ModelSelection | null;
}

export interface CatalogActions {
  readonly loadModelCatalog: (search?: string) => Promise<void>;
  readonly chooseModel: (model: ModelRef) => void;
}

export const catalogSlice: StateCreator<Store, [], [], CatalogState & CatalogActions> = (
  set,
  get,
) => ({
  catalog: IDLE,
  selected: null,
  unavailableSelection: null,

  loadModelCatalog: async (search = window.location.search) => {
    set({ catalog: LOADING });
    const catalog = await settle(api.fetchModelCatalog(), "The health models could not be listed.");
    if (catalog.kind !== "success") {
      set({ catalog, unavailableSelection: null });
      return;
    }
    const { selected, unavailable } = selectionFromSearch(search, catalog.value);
    set({ catalog, selected, unavailableSelection: unavailable });
    if (selected) void get().loadHealthModel();
  },

  // Switching models is the one place that clears what belonged to the previous model.
  chooseModel: (selected) => {
    set({
      selected,
      unavailableSelection: null,
      model: LOADING,
      refreshError: null,
      selectedName: null,
      detail: IDLE,
      report: IDLE,
      collapsed: [],
      highlightedName: null,
      focusNames: [],
      focusSeq: 0,
      chainNames: [],
    });
    void get().loadHealthModel();
  },
});
