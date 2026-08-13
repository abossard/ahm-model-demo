import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import type { Draft } from "@reduxjs/toolkit";
import type { ApiError, AsyncState, HealthModel } from "../model/types";
import type { RootState } from "./store";
import * as api from "./api";

interface ModelState {
  readonly data: AsyncState<HealthModel>;
  readonly lastObservedAt: string | null;
}

const initialState: ModelState = {
  data: { kind: "idle" },
  lastObservedAt: null,
};

export const loadHealthModel = createAsyncThunk<
  HealthModel,
  void,
  { state: RootState; rejectValue: ApiError }
>("model/load", async (_arg, { getState, rejectWithValue }) => {
  try {
    return await api.fetchHealthModel(getState().catalog.selected);
  } catch (error) {
    return rejectWithValue(error as ApiError);
  }
});

const modelSlice = createSlice({
  name: "model",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadHealthModel.pending, (state) => {
        state.data = { kind: "loading" };
      })
      .addCase(loadHealthModel.fulfilled, (state, action) => {
        state.data = { kind: "success", value: action.payload as Draft<HealthModel> };
        state.lastObservedAt = action.payload.observedAt;
      })
      .addCase(loadHealthModel.rejected, (state, action) => {
        const error: ApiError = action.payload ?? {
          code: "unknown",
          message: action.error.message ?? "The health model could not be loaded.",
          retryable: true,
          operationId: null,
        };
        state.data = { kind: "failure", error };
      });
  },
});

export const modelReducer = modelSlice.reducer;
