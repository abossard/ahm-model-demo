import { create } from "zustand";

interface OutlineState {
  /** What the viewer opened or closed, by entity name, true for open; an entity not named here follows the default. */
  readonly overrides: ReadonlyMap<string, boolean>;
  readonly setOpen: (name: string, open: boolean) => void;
  readonly replace: (overrides: ReadonlyMap<string, boolean>) => void;
}

/**
 * The outline's own open and closed rows. The toolbar's controls and the view both read them, and
 * no other view does, so they live here and not in the app's store.
 */
export const useOutlineState = create<OutlineState>()((set) => ({
  overrides: new Map(),
  setOpen: (name, open) => set((state) => ({ overrides: new Map(state.overrides).set(name, open) })),
  replace: (overrides) => set({ overrides }),
}));
