import type { StateCreator } from "zustand";
import { DEFAULT_LAYOUT_ID, type LayoutId } from "../model/layout";
import type { ConnectionPolicy, EdgeStyle } from "../model/edgeRouting";
import type { SortKey } from "../model/ordering";
import type { ThemeName } from "../model/theme";
import type { HealthState } from "../model/types";
import type { Store } from "./store";

export const REFRESH_COUNTDOWN_SECONDS = 10;
export const WORKSPACE_MIN_WIDTH = 320;
export const WORKSPACE_MAX_WIDTH = 760;
export const WORKSPACE_DEFAULT_WIDTH = 440;
export type HealthFilterState = Exclude<HealthState, "Deleted">;
export type ExcludedEntityMode = "hide" | "dot";
export type WorkspaceTab = "tasks" | "new";

export interface UiState {
  readonly theme: ThemeName;
  readonly themeExplicit: boolean;
  readonly autoRefreshMs: number;
  readonly refreshCountdown: number;
  readonly layoutId: LayoutId;
  readonly sortKey: SortKey;
  readonly sortReversed: boolean;
  readonly edgeStyle: EdgeStyle;
  readonly connectionPolicy: ConnectionPolicy;
  readonly collapsed: readonly string[];
  readonly searchOpen: boolean;
  readonly highlightedName: string | null;
  readonly focusNames: readonly string[];
  readonly focusSeq: number;
  /** The entities an open Explain result traces, marked on the graph. */
  readonly chainNames: readonly string[];
  readonly workspaceOpen: boolean;
  readonly workspaceWidth: number;
  readonly workspaceTab: WorkspaceTab;
  readonly announcement: string;
  readonly selectedHealth: readonly HealthFilterState[];
  readonly excludedEntityMode: ExcludedEntityMode;
}

export interface UiActions {
  readonly initializeTheme: (theme: ThemeName) => void;
  readonly setTheme: (theme: ThemeName) => void;
  readonly setAutoRefresh: (ms: number) => void;
  readonly tickRefreshCountdown: () => void;
  readonly setLayout: (layoutId: LayoutId) => void;
  readonly setSortKey: (sortKey: SortKey) => void;
  readonly toggleSortDirection: () => void;
  readonly setEdgeStyle: (edgeStyle: EdgeStyle) => void;
  readonly setConnectionPolicy: (policy: ConnectionPolicy) => void;
  readonly toggleCollapse: (name: string) => void;
  readonly expandMany: (names: readonly string[]) => void;
  readonly openSearch: () => void;
  readonly closeSearch: () => void;
  readonly focusEntities: (focus: { readonly highlight: string; readonly names: readonly string[] }) => void;
  readonly setChain: (names: readonly string[]) => void;
  readonly setWorkspaceOpen: (open: boolean) => void;
  readonly toggleWorkspace: () => void;
  readonly setWorkspaceWidth: (width: number) => void;
  readonly setWorkspaceTab: (tab: WorkspaceTab) => void;
  readonly announce: (message: string) => void;
  readonly setSelectedHealth: (states: readonly HealthFilterState[]) => void;
  readonly toggleSelectedHealth: (state: HealthFilterState) => void;
  readonly setExcludedEntityMode: (mode: ExcludedEntityMode) => void;
}

export const uiSlice: StateCreator<Store, [], [], UiState & UiActions> = (set, get) => ({
  theme: "light",
  themeExplicit: false,
  autoRefreshMs: 0,
  refreshCountdown: 0,
  layoutId: DEFAULT_LAYOUT_ID,
  sortKey: "shortest",
  sortReversed: false,
  edgeStyle: "smooth",
  connectionPolicy: "with-layout",
  collapsed: [],
  searchOpen: false,
  highlightedName: null,
  focusNames: [],
  focusSeq: 0,
  chainNames: [],
  workspaceOpen: false,
  workspaceWidth: WORKSPACE_DEFAULT_WIDTH,
  workspaceTab: "tasks",
  announcement: "",
  selectedHealth: ["Healthy", "Degraded", "Unhealthy", "Unknown"],
  excludedEntityMode: "hide",

  initializeTheme: (theme) => set({ theme, themeExplicit: false }),
  setTheme: (theme) => set({ theme, themeExplicit: true }),
  setAutoRefresh: (autoRefreshMs) => set({ autoRefreshMs }),
  // The countdown that an accepted report starts ends by refreshing the model.
  tickRefreshCountdown: () => {
    const remaining = get().refreshCountdown;
    if (remaining <= 0) return;
    set({ refreshCountdown: remaining - 1 });
    if (remaining === 1) void get().loadHealthModel();
  },
  setLayout: (layoutId) => set({ layoutId }),
  setSortKey: (sortKey) => set({ sortKey }),
  toggleSortDirection: () => set((state) => ({ sortReversed: !state.sortReversed })),
  setEdgeStyle: (edgeStyle) => set({ edgeStyle }),
  setConnectionPolicy: (connectionPolicy) => set({ connectionPolicy }),
  toggleCollapse: (name) =>
    set((state) => ({
      collapsed: state.collapsed.includes(name)
        ? state.collapsed.filter((item) => item !== name)
        : [...state.collapsed, name],
    })),
  expandMany: (names) => {
    const dropped = new Set(names);
    set((state) => ({ collapsed: state.collapsed.filter((name) => !dropped.has(name)) }));
  },
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  focusEntities: ({ highlight, names }) =>
    set((state) => ({
      highlightedName: highlight,
      focusNames: [...names],
      focusSeq: state.focusSeq + 1,
    })),
  setChain: (chainNames) => set({ chainNames: [...chainNames] }),
  setWorkspaceOpen: (workspaceOpen) => set({ workspaceOpen }),
  toggleWorkspace: () => set((state) => ({ workspaceOpen: !state.workspaceOpen })),
  setWorkspaceWidth: (width) =>
    set({ workspaceWidth: Math.min(WORKSPACE_MAX_WIDTH, Math.max(WORKSPACE_MIN_WIDTH, Math.round(width))) }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  announce: (announcement) => set({ announcement }),
  setSelectedHealth: (states) => set({ selectedHealth: [...new Set(states)] }),
  toggleSelectedHealth: (state) =>
    set((current) => ({
      selectedHealth: current.selectedHealth.includes(state)
        ? current.selectedHealth.filter((item) => item !== state)
        : [...current.selectedHealth, state],
    })),
  setExcludedEntityMode: (excludedEntityMode) => set({ excludedEntityMode }),
});
