import { createSlice } from "@reduxjs/toolkit";
import { chooseModel } from "./catalogSlice";

interface UiState {
  readonly panelOpen: boolean;
  readonly chatOpen: boolean;
}

const initialState: UiState = {
  panelOpen: false,
  chatOpen: false,
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
  },
  extraReducers: (builder) => {
    builder.addCase(chooseModel, (state) => {
      state.panelOpen = false;
    });
  },
});

export const { openPanel, closePanel, toggleChat } = uiSlice.actions;
export const uiReducer = uiSlice.reducer;
