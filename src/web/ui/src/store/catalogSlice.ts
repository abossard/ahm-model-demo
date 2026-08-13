import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import type { Draft } from "@reduxjs/toolkit";
import type { ApiError, AsyncState, ModelCatalog, ModelRef } from "../model/types";
import { selectionFromSearch } from "../model/selection";
import * as api from "./api";

interface CatalogState {
  readonly data: AsyncState<ModelCatalog>;
  readonly selected: ModelRef | null;
}

const initialState: CatalogState = {
  data: { kind: "idle" },
  selected: null,
};

export const loadModelCatalog = createAsyncThunk<
  { readonly catalog: ModelCatalog; readonly selected: ModelRef | null },
  void,
  { rejectValue: ApiError }
>("catalog/load", async (_arg, { rejectWithValue }) => {
  try {
    const catalog = await api.fetchModelCatalog();
    return { catalog, selected: selectionFromSearch(window.location.search, catalog) };
  } catch (error) {
    return rejectWithValue(error as ApiError);
  }
});

const catalogSlice = createSlice({
  name: "catalog",
  initialState,
  reducers: {
    chooseModel: (state, action: { payload: ModelRef }) => {
      state.selected = action.payload as Draft<ModelRef>;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadModelCatalog.pending, (state) => {
        state.data = { kind: "loading" };
      })
      .addCase(loadModelCatalog.fulfilled, (state, action) => {
        state.data = { kind: "success", value: action.payload.catalog as Draft<ModelCatalog> };
        state.selected = action.payload.selected as Draft<ModelRef> | null;
      })
      .addCase(loadModelCatalog.rejected, (state, action) => {
        const error: ApiError = action.payload ?? {
          code: "unknown",
          message: action.error.message ?? "The health models could not be listed.",
          retryable: true,
          operationId: null,
        };
        state.data = { kind: "failure", error };
      });
  },
});

export const { chooseModel } = catalogSlice.actions;
export const catalogReducer = catalogSlice.reducer;
