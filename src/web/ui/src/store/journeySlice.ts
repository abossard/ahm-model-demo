import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import type { Draft } from "@reduxjs/toolkit";
import type { ApiError, AsyncState, JourneyResult } from "../model/types";
import * as api from "./api";

interface JourneyState {
  readonly result: AsyncState<JourneyResult>;
}

const initialState: JourneyState = {
  result: { kind: "idle" },
};

export const runDemoRequest = createAsyncThunk<
  JourneyResult,
  void,
  { rejectValue: ApiError }
>("journey/run", async (_arg, { rejectWithValue }) => {
  try {
    return await api.postDemoRequest();
  } catch (error) {
    return rejectWithValue(error as ApiError);
  }
});

const journeySlice = createSlice({
  name: "journey",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(runDemoRequest.pending, (state) => {
        state.result = { kind: "loading" };
      })
      .addCase(runDemoRequest.fulfilled, (state, action) => {
        state.result = { kind: "success", value: action.payload as Draft<JourneyResult> };
      })
      .addCase(runDemoRequest.rejected, (state, action) => {
        const error: ApiError = action.payload ?? {
          code: "unknown",
          message: action.error.message ?? "The request journey failed.",
          retryable: true,
          operationId: null,
        };
        state.result = { kind: "failure", error };
      });
  },
});

export const journeyReducer = journeySlice.reducer;
