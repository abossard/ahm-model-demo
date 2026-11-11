import type { StateCreator } from "zustand";
import type { AsyncState, EntityDetail } from "../model/types";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";

export interface EntityState {
  readonly selectedName: string | null;
  readonly detail: AsyncState<EntityDetail>;
}

export interface EntityActions {
  readonly selectEntity: (name: string) => Promise<void>;
  readonly clearEntity: () => void;
}

export const entitySlice: StateCreator<Store, [], [], EntityState & EntityActions> = (
  set,
  get,
) => ({
  selectedName: null,
  detail: IDLE,

  // The detail panel is open exactly while an entity is selected.
  selectEntity: async (name) => {
    set({ selectedName: name, detail: LOADING, report: IDLE });
    const detail = await settle(
      api.fetchEntityDetail(name, get().selected),
      "The entity could not be loaded.",
    );
    if (get().selectedName === name) set({ detail });
  },

  clearEntity: () => set({ selectedName: null, detail: IDLE, report: IDLE }),
});
