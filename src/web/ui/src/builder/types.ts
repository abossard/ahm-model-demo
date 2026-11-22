import type { ActivityEvent, DiffTaskResult, ModelSelection, TaskStatus } from "../model/types";
import type { NextStep, ShowMeAction, ShowMeDescriptor } from "../showMe";

export interface ResourceGroup {
  id: string;
  name: string;
  subscriptionId: string;
  location: string;
}

export interface AzureResource {
  id: string;
  name: string;
  type: string;
  location: string;
}

export interface ResourceScope {
  groupIds: string[];
  resourceIds: string[];
  destinationGroupId: string;
  modelName: string;
}

export interface AnalysisRow {
  resourceId: string;
  displayName: string;
  purpose: string;
  impact: "Standard" | "Limited" | "Suppressed";
}

export interface Analysis {
  nextSteps?: NextStep[];
  kind: "builderAnalysis";
  showMe?: Record<string, ShowMeAction>;
  summary: string;
  rows: AnalysisRow[];
  plan?: {
    objective: string;
    flows: { name: string; objective: string; failureScenario: string;
      components: { name: string; resourceIds: string[]; signal: string }[] }[];
    gaps: string[];
    decisions?: { choice: string; reason: string; basis: "inventory" | "measurement" | "assumption" | "userInput"; resourceIds: string[] }[];
  };
  metrics?: (MetricSample & { operator: "GreaterThan" | "LessThan"; threshold: number })[];
  omittedMetrics?: {resourceId: string; reason: string}[];
}

interface MetricSample {
  resourceId: string;
  metricNamespace: string;
  metricName: string;
  aggregation: string;
  sample: number;
}

export interface BuilderEvidence {
  resources?: (AzureResource & {availabilityState?: string})[];
  observedMetrics?: (MetricSample & {unit: string; observedAt: string; count?: number})[];
  signalChecks?: {resourceId: string; status: string; detail: string}[];
}

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  tradeoff: string;
  groups: { name: string; purpose: string; resourceIds: string[] }[];
}

export interface Preview {
  structure?: "planned" | "direct" | "grouped";
  id: string;
  title: string;
  summary: string;
  tradeoff: string;
  entities: { name: string; displayName: string; x: number; y: number; resourceId?: string; impact: string; purpose?: string }[];
  relationships: { parent: string; child: string }[];
  monitoringScopes: string[];
  diff: Pick<DiffTaskResult, "findings" | "verification">;
  plan: string;
  modelspec: string;
}

export interface BuilderTask<Result> {
  seq: number;
  status: TaskStatus;
  showMeHandles?: ShowMeDescriptor[];
  builder: Partial<ResourceScope> & BuilderEvidence & {
    phase: string;
    rows?: AnalysisRow[];
    metrics?: Analysis["metrics"];
    analysisSeq?: number;
    revision?: { analysisSeq: number; prompt: string };
    previousPlan?: Analysis["plan"];
    previousMetrics?: Analysis["metrics"];
    previousOmittedMetrics?: Analysis["omittedMetrics"];
  };
  result?: Result;
  activity?: ActivityEvent[];
  createdAt?: string;
  finishedAt?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  error?: { message: string };
}

export interface BuilderState {
  sessionId: string | null;
  target?: ModelSelection & { location?: string };
  analysis?: BuilderTask<Analysis>;
  failedRevision?: BuilderTask<Analysis>;
  proposal?: BuilderTask<{ kind: "builderProposals"; proposals: Proposal[]; showMe?: Record<string, ShowMeAction>; nextSteps?: NextStep[] }>;
  creation?: {
    status: "creating" | "partial" | "created";
    proposalId: string;
    error?: string;
    written: string[];
    principalId?: string;
    monitoringScopes?: string[];
    monitoringAccess?: Record<string, { status: "confirmed" | "failed"; message?: string }>;
    target?: ModelSelection;
  };
}

export interface BuilderTools {
  open(sessionId: string): Promise<BuilderState>;
  groups(): Promise<{ groups: ResourceGroup[] }>;
  resources(groupId: string): Promise<{ resources: AzureResource[] }>;
  analyze(scope: ResourceScope, sessionId: string | null): Promise<BuilderState>;
  revise(sessionId: string, analysisSeq: number, rows: AnalysisRow[], prompt: string): Promise<BuilderState>;
  propose(sessionId: string, analysisSeq: number, rows: AnalysisRow[]): Promise<BuilderState>;
  preview(sessionId: string, proposalSeq: number, proposalId: string): Promise<Preview>;
  create(sessionId: string, proposalSeq: number, proposalId: string): Promise<BuilderState>;
  grantMonitoring(sessionId: string, proposalSeq: number): Promise<BuilderState>;
  showModel(sessionId: string, proposalSeq: number): Promise<void>;
  download(name: "plan.md" | "modelspec.md", markdown: string): Promise<void>;
}

export const isRunning = (task: { status: TaskStatus } | undefined): boolean =>
  task?.status === "queued" || task?.status === "running";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation could not be completed.";
}
