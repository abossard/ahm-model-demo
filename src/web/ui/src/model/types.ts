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
  /** Null for a signal the app discovered, which has no display name. */
  readonly displayName: string | null;
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

export interface ModelSummary {
  readonly id: string | null;
  readonly name: string;
  readonly location: string | null;
  readonly provisioningState: string | null;
  readonly healthState: HealthState;
}

export interface ModelSelection {
  readonly name: string;
  readonly resourceGroup: string;
  readonly subscriptionId: string;
}

export interface ModelRef extends ModelSelection {
  readonly id: string | null;
  readonly location: string | null;
  readonly provisioningState: string | null;
}

export type ModelDefault = ModelSelection;

export interface ModelCatalog {
  readonly models: readonly ModelRef[];
  /** The model that opens first: the app's own when the user can read it, else the first they can; null when they can read none. */
  readonly default: ModelDefault | null;
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
  readonly requestId?: string | null;
  /** The claims a Conditional Access policy asks for, on `interaction_required`. */
  readonly claims?: string | null;
}

/** What `GET /api/config` says about signing in; it needs no token. `local` means the server acts as the developer and nobody signs in. */
export interface AuthConfig {
  readonly authMode: "entra" | "local";
  readonly clientId: string | null;
  readonly apiScope: string | null;
}

export interface ApiErrorEnvelope {
  readonly error: ApiError;
}

export type AsyncState<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "failure"; readonly error: ApiError };

export type TaskType = "review" | "explain" | "design";
export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly taskCount: number;
  readonly lastTaskAt: string | null;
}

export interface TaskTarget extends ModelSelection {
  readonly entity?: string;
}

export interface TaskWorkload {
  readonly resourceGroup: string;
  readonly repositoryUrl?: string;
}

export interface TaskBase {
  readonly modelId: string;
  readonly fingerprint: string;
  readonly capturedAt: string;
}

export interface TaskError {
  readonly code: string;
  readonly message: string;
  /** Why the assistant's last result was rejected, when it was. */
  readonly problems?: readonly string[];
}

/** How sure the assistant says it is of a result. */
export type Confidence = "high" | "medium" | "low";

/** The span of time an explanation looked at. */
export interface ResultWindow {
  readonly from: string;
  readonly to: string;
}

export interface ExplainCause {
  readonly entity: string;
  readonly signal: string | null;
  readonly state: HealthState;
  readonly threshold: string | null;
  readonly value: SignalValue;
  readonly rollup: string | null;
  readonly note: string;
}

export interface ExplainResult {
  readonly kind: "explain";
  readonly entity: string;
  readonly state: HealthState;
  readonly summary: string;
  readonly causes: readonly ExplainCause[];
  readonly confidence?: Confidence;
  readonly window?: ResultWindow;
}

export type ChangeOp = "add" | "change" | "remove";
export type ChangeKind = "entity" | "signalDefinition" | "relationship";
export type VerificationStatus = "verified" | "failing" | "not_run";
export type FindingSeverity = "high" | "medium" | "low";

export interface VerificationRow {
  readonly entity: string;
  readonly signal: string;
  readonly status: VerificationStatus;
  readonly query: string | null;
  readonly value: SignalValue;
  readonly error: string | null;
}

export interface Finding {
  readonly severity: FindingSeverity;
  readonly entity: string | null;
  readonly text: string;
  readonly changeIds: readonly string[];
}

export interface ChangeDetail {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** What the agent submitted: a change has no `before`, details or dependencies yet. */
export interface SubmittedChange {
  readonly id: string;
  readonly op: ChangeOp;
  readonly kind: ChangeKind;
  readonly name: string;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly reason: string;
}

export interface DiffTaskResult {
  readonly kind: "diff";
  readonly summary: string;
  readonly changes: readonly SubmittedChange[];
  readonly verification: readonly VerificationRow[];
  readonly findings: readonly Finding[];
  readonly confidence?: Confidence;
}

export type TaskResult = ExplainResult | DiffTaskResult;

export interface Task {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: TaskType;
  readonly target: TaskTarget;
  readonly workload?: TaskWorkload;
  readonly instruction: string;
  readonly status: TaskStatus;
  readonly base?: TaskBase;
  readonly result?: TaskResult;
  readonly error?: TaskError;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export type TaskSummary = Omit<Task, "result">;

export interface SessionDetail {
  readonly session: SessionSummary;
  readonly tasks: readonly TaskSummary[];
}

export type ActivityKind = "status" | "text" | "tool_call" | "tool_result" | "result" | "error";

export interface ActivityEvent {
  readonly seq: number;
  readonly ts: string;
  readonly kind: ActivityKind;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DiffChange extends SubmittedChange {
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly details: readonly ChangeDetail[];
  readonly dependsOn: readonly string[];
  readonly verification: readonly VerificationRow[];
}

export interface ApplyFailure {
  readonly changeId: string;
  readonly code: string;
  readonly message: string;
}

export interface ApplyOutcome {
  readonly at?: string;
  readonly changeIds?: readonly string[];
  readonly expanded: readonly string[];
  readonly outcome: "applied" | "partial";
  readonly written: readonly string[];
  readonly failed: ApplyFailure | null;
}

export interface DiffView {
  readonly base: HealthModelSnapshot;
  readonly proposed: HealthModelSnapshot;
  readonly changes: readonly DiffChange[];
  readonly verification: readonly VerificationRow[];
  readonly findings: readonly Finding[];
  readonly summary: string;
  readonly target: TaskTarget;
  readonly appliable: boolean;
  readonly applies: readonly ApplyOutcome[];
}

export interface TaskInput {
  readonly type: TaskType;
  readonly target: TaskTarget;
  readonly workload?: TaskWorkload;
  readonly instruction: string;
}
