import { createSlice } from "@reduxjs/toolkit";

interface UiState {
  readonly panelOpen: boolean;
}

const initialState: UiState = {
  panelOpen: false,
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
  },
});

export const { openPanel, closePanel } = uiSlice.actions;
export const uiReducer = uiSlice.reducer;
