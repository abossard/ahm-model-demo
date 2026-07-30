import type {
  ApiError,
  EntityDetail,
  HealthModel,
  HealthReportBody,
  HealthReportResult,
  JourneyResult,
} from "../model/types";

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

export function fetchHealthModel(): Promise<HealthModel> {
  return requestJson<HealthModel>("/api/health-model");
}

export function fetchEntityDetail(name: string): Promise<EntityDetail> {
  return requestJson<EntityDetail>(`/api/entities/${encodeURIComponent(name)}`);
}

export function postHealthReport(
  name: string,
  body: HealthReportBody,
): Promise<HealthReportResult> {
  return requestJson<HealthReportResult>(
    `/api/entities/${encodeURIComponent(name)}/health-reports`,
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
