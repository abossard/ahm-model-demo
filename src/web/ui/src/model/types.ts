export type HealthState =
  | "Healthy"
  | "Degraded"
  | "Unhealthy"
  | "Unknown"
  | "Deleted";

export type SignalValue = string | number | null;

export interface ReportContext {
  readonly source?: "health-pulse-web";
  readonly reportId?: string | null;
  readonly reason?: string | null;
}

export interface EntitySignal extends ReportContext {
  readonly name: string;
  readonly displayName: string;
  readonly kind: string | null;
  readonly healthState: HealthState;
  readonly value: SignalValue;
  readonly reportedAt: string | null;
  readonly writable: boolean;
}

export interface CanvasPosition {
  readonly x: number | null;
  readonly y: number | null;
}

export interface EntityReport {
  readonly eligible: boolean;
  readonly signalName: string | null;
}

export interface Entity {
  readonly name: string;
  readonly displayName: string;
  readonly healthState: HealthState;
  readonly impact: string;
  readonly canvasPosition: CanvasPosition | null;
  readonly discoveredBy: string | null;
  readonly parents: readonly string[];
  readonly children: readonly string[];
  readonly unlinked: boolean;
  readonly latestEvaluationAt: string | null;
  readonly latestTransitionAt: string | null;
  readonly signals: readonly EntitySignal[];
  readonly report: EntityReport;
}

export interface Relationship {
  readonly name: string;
  readonly displayName: string | null;
  readonly parentEntityName: string;
  readonly childEntityName: string;
}

export interface ReasonPreset {
  readonly value: string;
  readonly label: string;
}

export interface ReportOptions {
  readonly signalName: string;
  readonly healthStates: readonly HealthState[];
  readonly values: readonly SignalValue[];
  readonly expiries: readonly number[];
  readonly reasonPresets: readonly ReasonPreset[];
}

export interface HealthReportBody {
  readonly signalName: string;
  readonly healthState: HealthState;
  readonly value: SignalValue;
  readonly expiresInMinutes: number;
  readonly reasonPreset: string;
  readonly customReason?: string;
}

export interface HealthReportResult {
  readonly status: string;
  readonly reportId: string;
  readonly entityName: string;
  readonly signalName: string;
  readonly requestedState: HealthState;
  readonly submittedAt: string;
  readonly expiresAt: string;
}

export interface JourneyQueueHead {
  readonly request_id: string | null;
}

export interface JourneyResult {
  readonly request_id: string;
  readonly queue_head: JourneyQueueHead | null;
  readonly row_count: number;
}

export interface ModelSummary {
  readonly id: string | null;
  readonly name: string;
  readonly location: string | null;
  readonly provisioningState: string | null;
  readonly healthState: HealthState;
}

export interface ModelRef {
  readonly id: string | null;
  readonly name: string;
  readonly resourceGroup: string;
  readonly location: string | null;
  readonly provisioningState: string | null;
}

export interface ModelDefault {
  readonly name: string;
  readonly resourceGroup: string;
}

export interface ModelCatalog {
  readonly models: readonly ModelRef[];
  readonly default: ModelDefault;
}

export interface HealthModel {
  readonly model: ModelSummary;
  readonly observedAt: string;
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
  readonly reportOptions: ReportOptions;
}

export interface HealthModelSnapshot {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

export interface Transition {
  readonly previousState: HealthState | null;
  readonly healthState: HealthState | null;
  readonly occurredAt: string | null;
}

export interface SignalHistoryItem extends ReportContext {
  readonly healthState: HealthState | null;
  readonly value: SignalValue;
  readonly occurredAt: string | null;
}

export interface CanonicalSignal {
  readonly name: string;
  readonly current: EntitySignal | null;
  readonly history: readonly SignalHistoryItem[];
}

export interface EntityDetail {
  readonly entity: Entity;
  readonly observedAt: string;
  readonly transitions: readonly Transition[];
  readonly canonicalSignal: CanonicalSignal;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly operationId: string | null;
}

export interface ApiErrorEnvelope {
  readonly error: ApiError;
}

export type AsyncState<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "failure"; readonly error: ApiError };
