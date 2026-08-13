import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import { chooseModel } from "./catalogSlice";
import { submitHealthReport } from "./reportSlice";

export const REFRESH_COUNTDOWN_SECONDS = 10;

interface UiState {
  readonly panelOpen: boolean;
  readonly chatOpen: boolean;
  readonly autoRefreshMs: number;
  readonly refreshCountdown: number;
}

const initialState: UiState = {
  panelOpen: false,
  chatOpen: false,
  autoRefreshMs: 0,
  refreshCountdown: 0,
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
  },
  extraReducers: (builder) => {
    builder
      .addCase(chooseModel, (state) => {
        state.panelOpen = false;
      })
      .addCase(submitHealthReport.fulfilled, (state) => {
        state.refreshCountdown = REFRESH_COUNTDOWN_SECONDS;
      });
  },
});

export const { openPanel, closePanel, toggleChat, setAutoRefresh, tickRefreshCountdown } =
  uiSlice.actions;
export const uiReducer = uiSlice.reducer;
