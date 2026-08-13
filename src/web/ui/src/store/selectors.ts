import type { RootState } from "./store";
import type {
  AsyncState,
  EntityDetail,
  HealthModel,
  HealthReportResult,
  JourneyResult,
  ModelCatalog,
  ModelRef,
} from "../model/types";

export function selectModelCatalog(state: RootState): AsyncState<ModelCatalog> {
  return state.catalog.data;
}

export function selectSelectedModel(state: RootState): ModelRef | null {
  return state.catalog.selected;
}

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

export function selectChatOpen(state: RootState): boolean {
  return state.ui.chatOpen;
}

export function selectModelRefreshing(state: RootState): boolean {
  return state.model.refreshing;
}

export function selectAutoRefreshMs(state: RootState): number {
  return state.ui.autoRefreshMs;
}

export function selectRefreshCountdown(state: RootState): number {
  return state.ui.refreshCountdown;
}
