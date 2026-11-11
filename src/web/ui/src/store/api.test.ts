import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAuth, setAuth, type Auth } from "../auth";
import type { HealthReportBody, ModelSelection } from "../model/types";
import * as api from "./api";

const SELECTION: ModelSelection = {
  name: "hm demo",
  resourceGroup: "rg-demo",
  subscriptionId: "11111111-1111-1111-1111-111111111111",
};
const SCOPE = "model=hm+demo&resourceGroup=rg-demo&subscription=11111111-1111-1111-1111-111111111111";
const BODY = { signalName: "s", healthState: "Healthy", value: null, expiresInMinutes: 5, reasonPreset: "p" } satisfies HealthReportBody;

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
  setAuth(localAuth);
});

describe("selector scoped requests", () => {
  it.each([
    { name: "health model", call: () => api.fetchHealthModel(SELECTION), url: "/api/health-model" },
    {
      name: "entity detail",
      call: () => api.fetchEntityDetail("svc/a", SELECTION),
      url: "/api/entities/svc%2Fa",
    },
    {
      name: "health report",
      call: () => api.postHealthReport("svc/a", BODY, SELECTION),
      url: "/api/entities/svc%2Fa/health-reports",
    },
  ])("$name sends model, resource group and subscription", async ({ call, url }) => {
    await call();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${url}?${SCOPE}`);
  });

  it.each([
    { name: "health model", call: () => api.fetchHealthModel(null), url: "/api/health-model" },
    { name: "entity detail", call: () => api.fetchEntityDetail("svc-a", null), url: "/api/entities/svc-a" },
  ])("$name sends no scope without a selection", async ({ call, url }) => {
    await call();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
  });
});

describe("failures", () => {
  it.each([
    {
      name: "an API error body",
      response: new Response(
        JSON.stringify({ error: { code: "sdk_unavailable", message: "down", retryable: true, operationId: "op-1" } }),
        { status: 503, headers: { "x-request-id": "req-1" } },
      ),
      expected: { code: "sdk_unavailable", message: "down", retryable: true, operationId: "op-1", requestId: "req-1" },
    },
    {
      name: "a body that is not an API error",
      response: new Response("nope", { status: 502, headers: { "x-operation-id": "op-2" } }),
      expected: {
        code: "http_error",
        message: "Request failed with status 502.",
        retryable: true,
        operationId: "op-2",
        requestId: null,
      },
    },
  ])("turns $name into an ApiError", async ({ response, expected }) => {
    fetchMock.mockResolvedValue(response);
    await expect(api.fetchModelCatalog()).rejects.toEqual(expected);
  });

  it("turns a network failure into a retryable ApiError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.fetchModelCatalog()).rejects.toMatchObject({
      code: "network_error",
      message: "Failed to fetch",
      retryable: true,
    });
  });
});

function signedIn(getToken: Auth["getToken"]): Auth {
  return { ready: vi.fn(), account: null, getToken, signIn: vi.fn(), signOut: vi.fn() };
}

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ error: { code, message: `message of ${code}`, retryable: false, operationId: "op", ...extra } }), { status });

const authorization = (call: number): string | null => new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit).headers).get("Authorization");

describe("the Authorization header", () => {
  it.each([
    { name: "a token", token: "token-1", header: "Bearer token-1" },
    { name: "no token, which is how local mode signs nobody in", token: null, header: null },
  ])("carries $name on every call", async ({ token, header }) => {
    setAuth(signedIn(vi.fn().mockResolvedValue(token)));
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    await api.fetchModelCatalog();
    await api.fetchSessions().catch(() => undefined);
    await api.postTask("s1", { type: "review", target: SELECTION, instruction: "" });
    await api.postHealthReport("svc-a", BODY, SELECTION);

    expect(fetchMock.mock.calls).toHaveLength(4);
    for (let call = 0; call < 4; call += 1) expect(authorization(call)).toBe(header);
  });

  it("keeps the headers of a call next to the token", async () => {
    setAuth(signedIn(vi.fn().mockResolvedValue("token-1")));
    await api.postTask("s1", { type: "review", target: SELECTION, instruction: "" });
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect([headers.get("Content-Type"), headers.get("Authorization")]).toEqual(["application/json", "Bearer token-1"]);
  });

  it("asks for the sign-in settings without a token, and before there is anybody to ask", async () => {
    const getToken = vi.fn().mockResolvedValue("token-1");
    setAuth(signedIn(getToken));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ authMode: "entra", tenantId: "t", clientId: "c", apiScope: "api://c/access_as_user" }), { status: 200 }));

    await expect(api.fetchAuthConfig()).resolves.toEqual({ authMode: "entra", tenantId: "t", clientId: "c", apiScope: "api://c/access_as_user" });

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/config");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).has("Authorization")).toBe(false);
  });

  it.each([
    { name: "local mode with nothing else", body: { authMode: "local" }, expected: { authMode: "local", tenantId: null, clientId: null, apiScope: null } },
  ])("fills what $name leaves out", async ({ body, expected }) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    await expect(api.fetchAuthConfig()).resolves.toEqual(expected);
  });

  it.each([
    { name: "a mode nobody knows", response: () => new Response(JSON.stringify({ authMode: "basic" }), { status: 200 }), code: "invalid_config" },
    { name: "a page that is not JSON", response: () => new Response("<html></html>", { status: 200 }), code: "invalid_config" },
    { name: "an error answer", response: () => refusal(500, "internal_error"), code: "internal_error" },
  ])("refuses $name as the sign-in settings", async ({ response, code }) => {
    fetchMock.mockImplementation(() => Promise.resolve(response()));
    await expect(api.fetchAuthConfig()).rejects.toMatchObject({ code });
  });
});

describe("a 401", () => {
  it.each([
    {
      name: "unauthenticated is retried once with a fresh token",
      first: () => refusal(401, "unauthenticated"),
      second: "token-2",
      retry: { refresh: true },
    },
    {
      name: "interaction_required is retried once with the claims the server named",
      first: () => refusal(401, "interaction_required", { claims: "eyJhY2Nlc3NfdG9rZW4iOnt9fQ==" }),
      second: "token-with-claims",
      retry: { claims: "eyJhY2Nlc3NfdG9rZW4iOnt9fQ==" },
    },
  ])("$name", async ({ first, second, retry }) => {
    const getToken = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce(second);
    setAuth(signedIn(getToken));
    fetchMock.mockResolvedValueOnce(first()).mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    await expect(api.fetchModelCatalog()).resolves.toEqual({ models: [] });

    expect(getToken.mock.calls).toEqual([[{}], [retry]]);
    expect([authorization(0), authorization(1)]).toEqual(["Bearer token-1", `Bearer ${second}`]);
  });

  it.each([
    { name: "unauthenticated twice", answer: () => refusal(401, "unauthenticated"), code: "unauthenticated" },
    { name: "interaction_required twice", answer: () => refusal(401, "interaction_required", { claims: "c" }), code: "interaction_required" },
  ])("is not retried a second time after $name", async ({ answer, code }) => {
    setAuth(signedIn(vi.fn().mockResolvedValue("token")));
    fetchMock.mockImplementation(() => Promise.resolve(answer()));

    await expect(api.fetchModelCatalog()).rejects.toMatchObject({ code });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "interaction_required without claims", answer: () => refusal(401, "interaction_required") },
    { name: "a code it does not know", answer: () => refusal(401, "token_expired") },
    { name: "a body that is not an error", answer: () => new Response("nope", { status: 401 }) },
  ])("is not retried for $name", async ({ answer }) => {
    const getToken = vi.fn().mockResolvedValue("token");
    setAuth(signedIn(getToken));
    fetchMock.mockImplementation(() => Promise.resolve(answer()));

    await expect(api.fetchModelCatalog()).rejects.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("is not retried when nobody signs in", async () => {
    fetchMock.mockResolvedValue(refusal(401, "unauthenticated"));
    await expect(api.fetchModelCatalog()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a 403 as it is, for the screen to say which Azure action it was", async () => {
    setAuth(signedIn(vi.fn().mockResolvedValue("token")));
    fetchMock.mockResolvedValue(refusal(403, "forbidden"));
    await expect(api.fetchModelCatalog()).rejects.toMatchObject({ code: "forbidden", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a token that cannot be had into a retryable ApiError", async () => {
    setAuth(signedIn(vi.fn().mockRejectedValue(new Error("The sign-in session ended."))));
    await expect(api.fetchModelCatalog()).rejects.toMatchObject({ code: "network_error", message: "The sign-in session ended.", retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the Activity timeline stream", () => {
  const encoder = new TextEncoder();
  const activity = (seq: number): string => `id: ${seq}\nevent: activity\ndata: {"seq":${seq}}\n\n`;
  const DONE = 'event: done\ndata: {"status":"done"}\n\n';

  /** A response that delivers the chunks and then ends, errors or waits, as the abort of its request ends it. */
  function respond(chunks: readonly string[], end: "close" | "hang" | "error", signal?: AbortSignal): Response {
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* the stream was closed already */
          }
        });
      },
      pull(controller) {
        if (next < chunks.length) {
          controller.enqueue(encoder.encode(chunks[next]));
          next += 1;
        } else if (end === "close") controller.close();
        else if (end === "error") controller.error(new TypeError("network error"));
        else return new Promise<void>(() => undefined);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  interface Heard {
    readonly activity: string[];
    readonly done: string[];
    readonly failure: unknown[];
  }

  function listen(): { readonly heard: Heard; readonly stream: api.TaskStream } {
    const heard: Heard = { activity: [], done: [], failure: [] };
    const stream = api.openTaskEvents("s1", 2, {
      onActivity: (data) => heard.activity.push(data),
      onDone: (data) => heard.done.push(data),
      onFailure: (error) => heard.failure.push(error),
    });
    return { heard, stream };
  }

  const headersOf = (call: number): Headers => new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit).headers);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    { name: "whole frames", chunks: [`${activity(1)}${activity(2)}${DONE}`] },
    { name: "frames cut anywhere", chunks: [activity(1).slice(0, 7), `${activity(1).slice(7)}${activity(2).slice(0, 20)}`, `${activity(2).slice(20)}${DONE.slice(0, 5)}`, DONE.slice(5)] },
    { name: "keep-alive comments between them", chunks: [`: keep-alive\n\n${activity(1)}: keep-alive\n\n`, `${activity(2)}${DONE}`] },
  ])("replays and follows $name, then ends with done and asks for nothing more", async ({ chunks }) => {
    fetchMock.mockImplementation((_url, init: RequestInit) => Promise.resolve(respond(chunks, "hang", init.signal ?? undefined)));
    const { heard } = listen();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(heard.activity).toEqual(['{"seq":1}', '{"seq":2}']);
    expect(heard.done).toEqual(['{"status":"done"}']);
    expect(heard.failure).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/s1/tasks/2/events");
    expect(headersOf(0).get("Accept")).toBe("text/event-stream");
    expect(headersOf(0).has("Last-Event-ID")).toBe(false);
  });

  it("sends the token on every connection and fetches a fresh one for each", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
    setAuth(signedIn(getToken));
    fetchMock.mockResolvedValueOnce(respond([activity(1)], "close")).mockResolvedValueOnce(respond([DONE], "close"));
    listen();

    await vi.advanceTimersByTimeAsync(5_000);

    expect([headersOf(0).get("Authorization"), headersOf(1).get("Authorization")]).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it.each([
    { name: "closes without done", first: () => respond([activity(1), activity(2)], "close") },
    { name: "breaks in the middle", first: () => respond([activity(1), activity(2)], "error") },
  ])("resumes with the last event id when the stream $name", async ({ first }) => {
    fetchMock.mockResolvedValueOnce(first()).mockResolvedValueOnce(respond([activity(3), DONE], "close"));
    const { heard } = listen();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(1).get("Last-Event-ID")).toBe("2");
    expect(heard.activity).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}']);
    expect(heard.done).toHaveLength(1);
  });

  it.each([
    { name: "half a second without a retry from the server", retry: "", wait: 499, then: 500 },
    { name: "the retry the server asked for", retry: "retry: 40\n\n", wait: 39, then: 40 },
  ])("waits $name before it reconnects", async ({ retry, wait, then }) => {
    fetchMock.mockResolvedValueOnce(respond([retry, activity(1)], "close")).mockResolvedValueOnce(respond([DONE], "close"));
    listen();

    await vi.advanceTimersByTimeAsync(wait);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(then - wait);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off, doubling up to the cap, and gives up after five failed reconnects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { heard } = listen();
    const calls = (): number => fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    for (const [wait, expected] of [[500, 2], [1000, 3], [2000, 4], [4000, 5], [8000, 6]] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(calls()).toBe(expected - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls()).toBe(expected);
    }

    expect(heard.failure).toMatchObject([{ code: "network_error", message: "Failed to fetch", retryable: true }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(6);
  });

  it("starts the count of failures again once the app answers with events", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("down"))
      .mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValueOnce(respond([activity(1)], "close"))
      .mockRejectedValueOnce(new TypeError("down"))
      .mockResolvedValue(respond([DONE], "close"));
    const { heard } = listen();

    await vi.advanceTimersByTimeAsync(30_000);

    // 500 ms, 1000 ms, then 500 ms and 1000 ms again, not 2000 ms and 4000 ms.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(heard.done).toHaveLength(1);
  });

  it.each([
    { name: "too_many_subscribers", status: 503, retryable: true },
    { name: "invalid_last_event_id", status: 400, retryable: false },
    { name: "task_not_found", status: 404, retryable: false },
  ])("ends with the code of a $name answer and does not reconnect", async ({ name, status, retryable }) => {
    fetchMock.mockResolvedValue(refusal(status, name, { retryable }));
    const { heard } = listen();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(heard.failure).toMatchObject([{ code: name, message: `message of ${name}`, retryable }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after a claims challenge, like any other call", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-claims");
    setAuth(signedIn(getToken));
    fetchMock.mockResolvedValueOnce(refusal(401, "interaction_required", { claims: "c" })).mockResolvedValueOnce(respond([activity(1), DONE], "close"));
    const { heard } = listen();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(getToken.mock.calls).toEqual([[{}], [{ claims: "c" }]]);
    expect(heard.done).toHaveLength(1);
  });

  it.each([
    { name: "while it waits to reconnect", chunks: [activity(1)], end: "close" as const, at: 100 },
    { name: "while it reads", chunks: [activity(1)], end: "hang" as const, at: 100 },
    { name: "before the first answer", chunks: [], end: "hang" as const, at: 0 },
  ])("stops for good when it is closed $name", async ({ chunks, end, at }) => {
    fetchMock.mockImplementation((_url, init: RequestInit) => Promise.resolve(respond(chunks, end, init.signal ?? undefined)));
    const { heard, stream } = listen();

    await vi.advanceTimersByTimeAsync(at);
    stream.close();
    const heardBefore = [...heard.activity];
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    expect(heard.activity).toEqual(heardBefore);
    expect(heard.done).toEqual([]);
    expect(heard.failure).toEqual([]);
  });
});
