import { record } from "../model";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function request<T>(
  path: string, parse: (value: unknown) => T,
  options: { method?: string; key?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.key) headers.Authorization = `Bearer ${options.key}`;
  let response: Response;
  try {
    response = await fetch(`/api/surveys${path}`, {
      method: options.method ?? "GET", headers, cache: "no-store",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, "Connection lost. Your edits are retained. Retry with the same key.");
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new ApiError(response.status, "The server returned an invalid response. Retain your edits and retry."); }
  if (!response.ok) {
    const message = record(value) && record(value.error) && typeof value.error.message === "string"
      ? value.error.message : "The request failed. Retain your edits and retry.";
    throw new ApiError(response.status, message);
  }
  return parse(value);
}
