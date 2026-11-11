import { getAuth, type TokenRequest } from "../auth";
import { parseLiveFrame, type LiveEvent } from "../model/live";
import { createSseParser } from "../model/sse";
import type {
  ApiError,
  ApplyOutcome,
  AuthConfig,
  DiffView,
  EntityDetail,
  HealthModel,
  HealthReportBody,
  HealthReportResult,
  ModelCatalog,
  ModelSelection,
  SessionDetail,
  SessionSummary,
  Task,
  TaskInput,
} from "../model/types";
import { searchFromSelection } from "../model/selection";
import type { TimelineResponse } from "../model/timeline";

function fallbackError(message: string): ApiError {
  return {
    code: "network_error",
    message,
    retryable: true,
    operationId: null,
    requestId: null,
  };
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: Partial<ApiError> | string;
    };
    const requestIdHeader = response.headers.get("x-request-id");
    const operationIdHeader = response.headers.get("x-operation-id");
    const error = body.error;
    if (error && typeof error === "object" && typeof error.message === "string") {
      return {
        code: error.code ?? "error",
        message: error.message,
        retryable: error.retryable ?? false,
        operationId: error.operationId ?? operationIdHeader ?? null,
        requestId: error.requestId ?? requestIdHeader ?? null,
        status: response.status,
        ...(typeof error.claims === "string" ? { claims: error.claims } : {}),
      };
    }
  } catch {
    /* non-JSON body */
  }
  return {
    code: "http_error",
    message: `Request failed with status ${response.status}.`,
    retryable: response.status >= 500,
    operationId: response.headers.get("x-operation-id"),
    requestId: response.headers.get("x-request-id"),
    status: response.status,
  };
}

/**
 * Every call to the app goes through here, so the token and what to do about a 401 are decided once. In `local`
 * mode there is no token and nothing is retried. A 401 is retried at most once: `unauthenticated` with a fresh
 * token, `interaction_required` after an interactive step with the claims the server sent (which, in a redirect
 * flow, leaves the page, so the retry is the page that comes back).
 */
async function authorized(url: string, init: RequestInit = {}): Promise<Response> {
  const auth = getAuth();
  let request: TokenRequest = {};
  for (let attempt = 0; ; attempt += 1) {
    const token = await auth.getToken(request);
    const headers = new Headers(init.headers);
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers });
    if (response.status !== 401 || token === null || attempt > 0) return response;
    const error = await readError(response.clone());
    if (error.code === "interaction_required" && error.claims) request = { claims: error.claims };
    else if (error.code === "unauthenticated") request = { refresh: true };
    else return response;
  }
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await authorized(url, init);
  } catch (cause) {
    if (init?.signal?.aborted) throw cause;
    throw fallbackError(cause instanceof Error ? cause.message : "Network request failed.");
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await send(url, init);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as T;
}

/** What the app says about signing in. It needs no token, and it is the only call made before there is an auth. */
export async function fetchAuthConfig(): Promise<AuthConfig> {
  let response: Response;
  try {
    response = await fetch("/api/config", { headers: { Accept: "application/json" } });
  } catch (cause) {
    throw fallbackError(cause instanceof Error ? cause.message : "Network request failed.");
  }
  if (!response.ok) throw await readError(response);
  try {
    const config = (await response.json()) as Partial<AuthConfig>;
    if (config.authMode !== "entra" && config.authMode !== "local") throw new Error("unknown authMode");
    return {
      authMode: config.authMode,
      clientId: config.clientId ?? null,
      apiScope: config.apiScope ?? null,
    };
  } catch {
    throw { ...fallbackError("The app's sign-in settings are not valid."), code: "invalid_config", retryable: false };
  }
}

function scoped(path: string, selection: ModelSelection | null): string {
  return selection ? `${path}${searchFromSelection(selection)}` : path;
}

export function fetchModelCatalog(): Promise<ModelCatalog> {
  return requestJson<ModelCatalog>("/api/health-models");
}

/** `fresh` makes the app read the model from Azure now instead of answering from what it keeps warm. */
export function fetchHealthModel(selection: ModelSelection | null, fresh = false): Promise<HealthModel> {
  const url = scoped("/api/health-model", selection);
  return requestJson<HealthModel>(fresh ? `${url}${url.includes("?") ? "&" : "?"}refresh=1` : url);
}

export function fetchEntityDetail(
  name: string,
  selection: ModelSelection | null,
): Promise<EntityDetail> {
  return requestJson<EntityDetail>(
    scoped(`/api/entities/${encodeURIComponent(name)}`, selection),
  );
}

export function postHealthReport(
  name: string,
  body: HealthReportBody,
  selection: ModelSelection | null,
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

function sessionPath(sid: string): string {
  return `/api/sessions/${encodeURIComponent(sid)}`;
}

function taskPath(sid: string, seq: number): string {
  return `${sessionPath(sid)}/tasks/${seq}`;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function fetchSessions(): Promise<readonly SessionSummary[]> {
  return (await requestJson<{ readonly sessions: readonly SessionSummary[] }>("/api/sessions")).sessions;
}

export function createSession(title?: string): Promise<SessionSummary> {
  return postJson<SessionSummary>("/api/sessions", title ? { title } : {});
}

export function fetchSession(sid: string): Promise<SessionDetail> {
  return requestJson<SessionDetail>(sessionPath(sid));
}

export function postTask(sid: string, input: TaskInput): Promise<Task> {
  return postJson<Task>(`${sessionPath(sid)}/tasks`, input);
}

export function fetchTask(sid: string, seq: number): Promise<Task> {
  return requestJson<Task>(taskPath(sid, seq));
}

export function fetchDiff(sid: string, seq: number): Promise<DiffView> {
  return requestJson<DiffView>(`${taskPath(sid, seq)}/diff`);
}

export function postApply(
  sid: string,
  seq: number,
  changeIds: readonly string[],
): Promise<ApplyOutcome> {
  return postJson<ApplyOutcome>(`${taskPath(sid, seq)}/apply`, { changeIds });
}

export interface TaskStreamHandlers {
  /** The data of an `activity` event: one Activity event as JSON text. */
  readonly onActivity: (data: string) => void;
  /** The data of the `done` event. The stream has ended for good. */
  readonly onDone: (data: string) => void;
  /**
   * The stream ended for good without `done`: the app refused it (`too_many_subscribers`, `invalid_last_event_id`,
   * a 401 it kept) or the connection stayed down through every retry.
   */
  readonly onFailure: (error: ApiError) => void;
}

export interface TaskStream {
  /** Stops following. Nothing is delivered afterwards. */
  readonly close: () => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 8000;
/** Consecutive reconnects that fail before the stream gives up. */
const RECONNECT_ATTEMPTS = 5;

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * The Activity timeline of a Task: replayed from the first event, then followed live. It reads the event stream with
 * `fetch`, because an `EventSource` cannot send the Authorization header. A dropped connection is resumed with the
 * last event id after a delay that doubles from the server's `retry:` (or half a second) up to eight seconds.
 */
export function openTaskEvents(sid: string, seq: number, handlers: TaskStreamHandlers): TaskStream {
  const controller = new AbortController();
  const { signal } = controller;
  const url = `${taskPath(sid, seq)}/events`;

  const follow = async (): Promise<void> => {
    const parser = createSseParser();
    const decoder = new TextDecoder();
    let lastId: string | null = null;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await authorized(url, {
          headers: { Accept: "text/event-stream", ...(lastId === null ? {} : { "Last-Event-ID": lastId }) },
          signal,
        });
        if (!response.ok) {
          if (!signal.aborted) handlers.onFailure(await readError(response));
          return;
        }
        if (response.body === null) throw new Error("The event stream has no body.");
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            failures = 0;
            if (frame.id !== null) lastId = frame.id;
            if (signal.aborted) return;
            if (frame.event === "activity") handlers.onActivity(frame.data);
            else if (frame.event === "done") {
              void reader.cancel();
              handlers.onDone(frame.data);
              return;
            }
          }
        }
      } catch (cause) {
        if (signal.aborted) return;
        failures += 1;
        if (failures > RECONNECT_ATTEMPTS) {
          handlers.onFailure(fallbackError(cause instanceof Error ? cause.message : "The live connection was lost."));
          return;
        }
      }
      // The connection ended without `done`, or broke: take it up again where it stopped.
      failures = Math.max(failures, 1);
      const base = parser.retry() ?? RECONNECT_BASE_MS;
      await pause(Math.min(RECONNECT_CAP_MS, base * 2 ** (failures - 1)), signal);
    }
  };

  void follow();
  return { close: () => controller.abort() };
}

export interface TimelineQuery {
  readonly from: number;
  readonly to: number;
  readonly include: readonly ("states" | "annotations" | "reports" | "signals")[];
  readonly entities?: readonly string[];
}

/** The history of the selected model for the signal timeline: GET /api/timeline. `signal` cancels it. */
export function fetchTimeline(
  selection: ModelSelection | null,
  query: TimelineQuery,
  signal?: AbortSignal,
): Promise<TimelineResponse> {
  const params = new URLSearchParams(selection ? searchFromSelection(selection) : "");
  params.set("from", new Date(query.from).toISOString());
  params.set("to", new Date(query.to).toISOString());
  params.set("include", query.include.join(","));
  for (const entity of query.entities ?? []) params.append("entity", entity);
  return requestJson<TimelineResponse>(`/api/timeline?${params.toString()}`, signal ? { signal } : undefined);
}

export type ModelStreamStatus = "connecting" | "open" | "reconnecting";

export interface ModelStreamHandlers {
  readonly onEvent: (event: LiveEvent) => void;
  readonly onStatus: (status: ModelStreamStatus) => void;
  /** The stream ended for good: the app refused it, or the account lost access. The caller falls back to polling. */
  readonly onFailure: (error: ApiError) => void;
}

export interface ModelStream {
  readonly close: () => void;
}

const LIVE_BACKOFF_BASE_MS = 500;
const LIVE_BACKOFF_CAP_MS = 30_000;
/** The server sends a comment every 15 s: a connection that stays silent for three times that is dead. */
const LIVE_SILENCE_MS = 45_000;

/**
 * The live feed of the selected model: GET /api/health-model/stream, read with `fetch` so it carries the token. A token
 * that expires ends the stream with `reconnect`; the next connection takes a fresh one and the last event id, so the
 * viewer sees no gap. A dropped connection is taken up again after a delay that doubles up to 30 s. `resync` and a
 * server that no longer knows the id make the next connection start from a snapshot.
 */
export function openModelStream(selection: ModelSelection | null, handlers: ModelStreamHandlers): ModelStream {
  const controller = new AbortController();
  const { signal } = controller;
  const url = `/api/health-model/stream${selection ? searchFromSelection(selection) : ""}`;

  const follow = async (): Promise<void> => {
    const parser = createSseParser();
    const decoder = new TextDecoder();
    let lastId: string | null = null;
    let failures = 0;
    let first = true;
    while (!signal.aborted) {
      handlers.onStatus(first ? "connecting" : "reconnecting");
      first = false;
      const connection = new AbortController();
      const stop = (): void => connection.abort();
      signal.addEventListener("abort", stop, { once: true });
      let silence = 0;
      const watch = (): void => {
        window.clearTimeout(silence);
        silence = window.setTimeout(stop, LIVE_SILENCE_MS);
      };
      let again = "backoff";
      try {
        const response = await authorized(url, {
          headers: { Accept: "text/event-stream", ...(lastId === null ? {} : { "Last-Event-ID": lastId }) },
          signal: connection.signal,
        });
        if (!response.ok) {
          if (!signal.aborted) handlers.onFailure(await readError(response));
          return;
        }
        if (response.body === null) throw new Error("The live stream has no body.");
        handlers.onStatus("open");
        watch();
        const reader = response.body.getReader();
        read: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          watch();
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            failures = 0;
            if (signal.aborted) return;
            const event = parseLiveFrame(frame.event, frame.data, frame.id);
            if (frame.id !== null) lastId = frame.id;
            if (event === null) continue;
            if (event.kind === "error") {
              handlers.onFailure({ code: event.code, message: event.message, retryable: false, operationId: null });
              void reader.cancel();
              return;
            }
            handlers.onEvent(event);
            if (event.kind === "resync" || event.kind === "reconnect") {
              if (event.kind === "resync") lastId = null;
              again = "now";
              void reader.cancel();
              break read;
            }
          }
        }
      } catch (cause) {
        if (signal.aborted) return;
        failures += 1;
        void cause;
      } finally {
        window.clearTimeout(silence);
        signal.removeEventListener("abort", stop);
      }
      if (signal.aborted) return;
      if (again === "now") continue;
      failures = Math.max(failures, 1);
      await pause(Math.min(LIVE_BACKOFF_CAP_MS, (parser.retry() ?? LIVE_BACKOFF_BASE_MS) * 2 ** (failures - 1)), signal);
    }
  };

  void follow();
  return { close: () => controller.abort() };
}
