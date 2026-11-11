import type { ApiError, AsyncState } from "../model/types";

export const IDLE: AsyncState<never> = { kind: "idle" };
export const LOADING: AsyncState<never> = { kind: "loading" };

function asApiError(error: unknown, fallbackMessage: string): ApiError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error as ApiError;
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: true,
    operationId: null,
  };
}

/** Awaits a request into the state its slice stores: `success` with the value, or `failure`. */
export async function settle<T>(
  request: Promise<T>,
  fallbackMessage: string,
): Promise<AsyncState<T>> {
  try {
    return { kind: "success", value: await request };
  } catch (error) {
    return { kind: "failure", error: asApiError(error, fallbackMessage) };
  }
}
