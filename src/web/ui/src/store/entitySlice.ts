import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import type { Draft } from "@reduxjs/toolkit";
import type { ApiError, AsyncState, EntityDetail } from "../model/types";
import * as api from "./api";

interface EntityState {
  readonly selectedName: string | null;
  readonly detail: AsyncState<EntityDetail>;
}

const initialState: EntityState = {
  selectedName: null,
  detail: { kind: "idle" },
};

export const loadEntityDetail = createAsyncThunk<
  EntityDetail,
  string,
  { rejectValue: ApiError }
>("entity/load", async (name, { rejectWithValue }) => {
  try {
    return await api.fetchEntityDetail(name);
  } catch (error) {
    return rejectWithValue(error as ApiError);
  }
});

const entitySlice = createSlice({
  name: "entity",
  initialState,
  reducers: {
    selectEntity: (state, action: { payload: string }) => {
      state.selectedName = action.payload;
      state.detail = { kind: "idle" };
    },
    clearEntity: (state) => {
      state.selectedName = null;
      state.detail = { kind: "idle" };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadEntityDetail.pending, (state) => {
        state.detail = { kind: "loading" };
      })
      .addCase(loadEntityDetail.fulfilled, (state, action) => {
        state.detail = { kind: "success", value: action.payload as Draft<EntityDetail> };
      })
      .addCase(loadEntityDetail.rejected, (state, action) => {
        const error: ApiError = action.payload ?? {
          code: "unknown",
          message: action.error.message ?? "The entity could not be loaded.",
          retryable: true,
          operationId: null,
        };
        state.detail = { kind: "failure", error };
      });
  },
});

export const { selectEntity, clearEntity } = entitySlice.actions;
export const entityReducer = entitySlice.reducer;
