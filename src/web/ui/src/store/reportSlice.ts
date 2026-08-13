import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import type { Draft } from "@reduxjs/toolkit";
import type {
  ApiError,
  AsyncState,
  HealthReportBody,
  HealthReportResult,
} from "../model/types";
import type { RootState } from "./store";
import * as api from "./api";

interface ReportState {
  readonly result: AsyncState<HealthReportResult>;
}

const initialState: ReportState = {
  result: { kind: "idle" },
};

export const submitHealthReport = createAsyncThunk<
  HealthReportResult,
  { readonly name: string; readonly body: HealthReportBody },
  { state: RootState; rejectValue: ApiError }
>("report/submit", async ({ name, body }, { getState, rejectWithValue }) => {
  try {
    return await api.postHealthReport(name, body, getState().catalog.selected);
  } catch (error) {
    return rejectWithValue(error as ApiError);
  }
});

const reportSlice = createSlice({
  name: "report",
  initialState,
  reducers: {
    resetReport: (state) => {
      state.result = { kind: "idle" };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(submitHealthReport.pending, (state) => {
        state.result = { kind: "loading" };
      })
      .addCase(submitHealthReport.fulfilled, (state, action) => {
        state.result = { kind: "success", value: action.payload as Draft<HealthReportResult> };
      })
      .addCase(submitHealthReport.rejected, (state, action) => {
        const error: ApiError = action.payload ?? {
          code: "unknown",
          message: action.error.message ?? "The report could not be submitted.",
          retryable: true,
          operationId: null,
        };
        state.result = { kind: "failure", error };
      });
  },
});

export const { resetReport } = reportSlice.actions;
export const reportReducer = reportSlice.reducer;
