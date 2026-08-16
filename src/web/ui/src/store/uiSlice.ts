import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import { chooseModel } from "./catalogSlice";
import { submitHealthReport } from "./reportSlice";
import { DEFAULT_LAYOUT_ID, type LayoutId } from "../model/layout";
import type { SortKey } from "../model/ordering";

export const REFRESH_COUNTDOWN_SECONDS = 10;

interface UiState {
  readonly panelOpen: boolean;
  readonly chatOpen: boolean;
  readonly autoRefreshMs: number;
  readonly refreshCountdown: number;
  readonly layoutId: LayoutId;
  readonly sortKey: SortKey;
  readonly sortReversed: boolean;
  readonly collapsed: readonly string[];
  readonly searchOpen: boolean;
  readonly highlightedName: string | null;
  readonly focusNames: readonly string[];
  readonly focusSeq: number;
  readonly announcement: string;
}

const initialState: UiState = {
  panelOpen: false,
  chatOpen: false,
  autoRefreshMs: 0,
  refreshCountdown: 0,
  layoutId: DEFAULT_LAYOUT_ID,
  sortKey: "name",
  sortReversed: false,
  collapsed: [],
  searchOpen: false,
  highlightedName: null,
  focusNames: [],
  focusSeq: 0,
  announcement: "",
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    openPanel: (state) => {
      state.panelOpen = true;
    },
    closePanel: (state) => {
      state.panelOpen = false;
    },
    toggleChat: (state) => {
      state.chatOpen = !state.chatOpen;
    },
    setAutoRefresh: (state, action: PayloadAction<number>) => {
      state.autoRefreshMs = action.payload;
    },
    tickRefreshCountdown: (state) => {
      if (state.refreshCountdown > 0) state.refreshCountdown -= 1;
    },
    setLayout: (state, action: PayloadAction<LayoutId>) => {
      state.layoutId = action.payload;
    },
    setSortKey: (state, action: PayloadAction<SortKey>) => {
      state.sortKey = action.payload;
    },
    toggleSortDirection: (state) => {
      state.sortReversed = !state.sortReversed;
    },
    toggleCollapse: (state, action: PayloadAction<string>) => {
      state.collapsed = state.collapsed.includes(action.payload)
        ? state.collapsed.filter((name) => name !== action.payload)
        : [...state.collapsed, action.payload];
    },
    expandMany: (state, action: PayloadAction<readonly string[]>) => {
      const dropped = new Set(action.payload);
      state.collapsed = state.collapsed.filter((name) => !dropped.has(name));
    },
    openSearch: (state) => {
      state.searchOpen = true;
    },
    closeSearch: (state) => {
      state.searchOpen = false;
    },
    focusEntities: (
      state,
      action: PayloadAction<{ readonly highlight: string; readonly names: readonly string[] }>,
    ) => {
      state.highlightedName = action.payload.highlight;
      state.focusNames = [...action.payload.names];
      state.focusSeq += 1;
    },
    announce: (state, action: PayloadAction<string>) => {
      state.announcement = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(chooseModel, (state) => {
        state.panelOpen = false;
        state.collapsed = [];
        state.highlightedName = null;
      })
      .addCase(submitHealthReport.fulfilled, (state) => {
        state.refreshCountdown = REFRESH_COUNTDOWN_SECONDS;
      });
  },
});

export const {
  openPanel,
  closePanel,
  toggleChat,
  setAutoRefresh,
  tickRefreshCountdown,
  setLayout,
  setSortKey,
  toggleSortDirection,
  toggleCollapse,
  expandMany,
  openSearch,
  closeSearch,
  focusEntities,
  announce,
} = uiSlice.actions;
export const uiReducer = uiSlice.reducer;
