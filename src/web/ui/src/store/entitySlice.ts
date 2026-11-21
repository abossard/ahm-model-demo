import type { StateCreator } from "zustand";
import type { AsyncState, EntityDetail } from "../model/types";
import * as api from "./api";
import { IDLE, settle } from "./asyncState";
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
    // Same-named entities can be opened back to back, including in different models.
    const loading = { kind: "loading" } as const;
    set({ selectedName: name, detail: loading, report: IDLE });
    const detail = await settle(
      api.fetchEntityDetail(name, get().selected),
      "The entity could not be loaded.",
    );
    if (get().detail === loading) set({ detail });
  },

  clearEntity: () => set({ selectedName: null, detail: IDLE, report: IDLE }),
});
