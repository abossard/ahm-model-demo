import type { StateCreator } from "zustand";
import type { AsyncState, HealthReportBody, HealthReportResult } from "../model/types";
import * as api from "./api";
import { IDLE, LOADING, settle } from "./asyncState";
import type { Store } from "./store";
import { REFRESH_COUNTDOWN_SECONDS } from "./uiSlice";

export interface ReportState {
  readonly report: AsyncState<HealthReportResult>;
}

export interface ReportActions {
  readonly submitHealthReport: (name: string, body: HealthReportBody) => Promise<void>;
}

export const reportSlice: StateCreator<Store, [], [], ReportState & ReportActions> = (
  set,
  get,
) => ({
  report: IDLE,

  submitHealthReport: async (name, body) => {
    set({ report: LOADING });
    const report = await settle(
      api.postHealthReport(name, body, get().selected),
      "The health report could not be sent.",
    );
    // An accepted report starts the countdown to the refresh that shows its effect.
    set({
      report,
      ...(report.kind === "success" ? { refreshCountdown: REFRESH_COUNTDOWN_SECONDS } : {}),
    });
  },
});
