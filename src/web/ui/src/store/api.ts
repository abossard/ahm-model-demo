import type {
  ApiError,
  EntityDetail,
  HealthModel,
  HealthReportBody,
  HealthReportResult,
  JourneyResult,
  ModelCatalog,
  ModelRef,
} from "../model/types";
import { searchFromSelection } from "../model/selection";

function fallbackError(message: string): ApiError {
  return { code: "network_error", message, retryable: true, operationId: null };
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: Partial<ApiError> };
    const error = body.error;
    if (error && typeof error.message === "string") {
      return {
        code: error.code ?? "error",
        message: error.message,
        retryable: error.retryable ?? false,
        operationId: error.operationId ?? null,
      };
    }
  } catch {
    /* non-JSON body */
  }
  return {
    code: "http_error",
    message: `Request failed with status ${response.status}.`,
    retryable: response.status >= 500,
    operationId: null,
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw fallbackError(cause instanceof Error ? cause.message : "Network request failed.");
  }
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as T;
}

function scoped(path: string, selection: ModelRef | null): string {
  return selection ? `${path}${searchFromSelection(selection)}` : path;
}

export function fetchModelCatalog(): Promise<ModelCatalog> {
  return requestJson<ModelCatalog>("/api/health-models");
}

export function fetchHealthModel(selection: ModelRef | null): Promise<HealthModel> {
  return requestJson<HealthModel>(scoped("/api/health-model", selection));
}

export function fetchEntityDetail(
  name: string,
  selection: ModelRef | null,
): Promise<EntityDetail> {
  return requestJson<EntityDetail>(
    scoped(`/api/entities/${encodeURIComponent(name)}`, selection),
  );
}

export function postHealthReport(
  name: string,
  body: HealthReportBody,
  selection: ModelRef | null,
): Promise<HealthReportResult> {
  return requestJson<HealthReportResult>(
    scoped(`/api/entities/${encodeURIComponent(name)}/health-reports`, selection),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export function postDemoRequest(): Promise<JourneyResult> {
  return requestJson<JourneyResult>("/api/demo-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}
