import type { RootState } from "./store";
import type {
  AsyncState,
  EntityDetail,
  HealthModel,
  HealthReportResult,
  JourneyResult,
} from "../model/types";

export function selectModel(state: RootState): AsyncState<HealthModel> {
  return state.model.data;
}

export function selectLastObservedAt(state: RootState): string | null {
  return state.model.lastObservedAt;
}

export function selectSelectedName(state: RootState): string | null {
  return state.entity.selectedName;
}

export function selectEntityDetail(state: RootState): AsyncState<EntityDetail> {
  return state.entity.detail;
}

export function selectReportResult(
  state: RootState,
): AsyncState<HealthReportResult> {
  return state.report.result;
}

export function selectJourneyResult(state: RootState): AsyncState<JourneyResult> {
  return state.journey.result;
}

export function selectPanelOpen(state: RootState): boolean {
  return state.ui.panelOpen;
}
