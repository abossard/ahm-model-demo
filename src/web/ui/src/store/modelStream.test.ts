import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAuth, setAuth } from "../auth";
import type { LiveEvent } from "../model/live";
import type { ApiError } from "../model/types";
import * as api from "./api";

const SELECTION = { name: "hm", resourceGroup: "rg", subscriptionId: "11111111-1111-1111-1111-111111111111" };
const fetchMock = vi.fn();
const encoder = new TextEncoder();
const snapshot = (id: string): string => `id: ${id}\nevent: snapshot\ndata: {"entities":[],"relationships":[]}\n\n`;
const delta = (id: string): string => `id: ${id}\nevent: delta\ndata: {"observedAt":"${id}"}\n\n`;

function respond(chunks: readonly string[], end: "close" | "hang", signal?: AbortSignal): Response {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* closed already */
        }
      });
    },
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(encoder.encode(chunks[next]));
        next += 1;
      } else if (end === "close") controller.close();
      else return new Promise<void>(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function listen(): { events: LiveEvent[]; statuses: string[]; failures: ApiError[]; stream: api.ModelStream } {
  const events: LiveEvent[] = [];
  const statuses: string[] = [];
  const failures: ApiError[] = [];
  const stream = api.openModelStream(SELECTION, {
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onFailure: (error) => failures.push(error),
  });
  return { events, statuses, failures, stream };
}

const headersOf = (call: number): Headers => new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit).headers);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
  setAuth(localAuth);
});

describe("the live stream of a model", () => {
  it.each([
    { name: "whole frames", chunks: [`${snapshot("e-0")}${delta("e-1")}`] },
    { name: "frames cut anywhere", chunks: [snapshot("e-0").slice(0, 9), `${snapshot("e-0").slice(9)}${delta("e-1").slice(0, 12)}`, delta("e-1").slice(12)] },
    { name: "keep-alive comments and retry between them", chunks: [`retry: 3000\n\n: keep-alive\n\n${snapshot("e-0")}: keep-alive\n\n`, delta("e-1")] },
  ])("delivers the snapshot and the delta from $name and stays connected", async ({ chunks }) => {
    fetchMock.mockImplementation((_url, init: RequestInit) => Promise.resolve(respond(chunks, "hang", init.signal ?? undefined)));
    const heard = listen();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(heard.events.map((event) => event.kind)).toEqual(["snapshot", "delta"]);
    expect(heard.events.map((event) => ("id" in event ? event.id : null))).toEqual(["e-0", "e-1"]);
    expect(heard.statuses).toEqual(["connecting", "open"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/health-model/stream?model=hm&resourceGroup=rg&subscription=11111111-1111-1111-1111-111111111111");
    expect(headersOf(0).get("Accept")).toBe("text/event-stream");
    expect(headersOf(0).has("Last-Event-ID")).toBe(false);
    heard.stream.close();
  });

  it("takes a dropped connection up again with the last id and a delay that doubles", async () => {
    fetchMock
      .mockResolvedValueOnce(respond([snapshot("e-0"), delta("e-1")], "close"))
      .mockRejectedValueOnce(new TypeError("network error"))
      .mockRejectedValueOnce(new TypeError("network error"))
      .mockImplementation((_url, init: RequestInit) => Promise.resolve(respond([delta("e-2")], "hang", init.signal ?? undefined)));
    const heard = listen();

    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(800);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_800);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect([1, 2, 3].map((call) => headersOf(call).get("Last-Event-ID"))).toEqual(["e-1", "e-1", "e-1"]);
    expect(heard.events.map((event) => event.kind)).toEqual(["snapshot", "delta", "delta"]);
    expect(heard.statuses).toContain("reconnecting");
    expect(heard.failures).toEqual([]);
    heard.stream.close();
  });

  it("fetches a fresh token for every connection", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
    setAuth({ ...localAuth, getToken } as never);
    fetchMock.mockResolvedValueOnce(respond([snapshot("e-0")], "close")).mockImplementation((_url, init: RequestInit) => Promise.resolve(respond([], "hang", init.signal ?? undefined)));
    const heard = listen();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(getToken).toHaveBeenCalledTimes(2);
    expect([0, 1].map((call) => headersOf(call).get("Authorization"))).toEqual(["Bearer token-1", "Bearer token-2"]);
    heard.stream.close();
  });

  it("a reconnect event connects again at once with the last id, and a resync starts from a snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(respond([snapshot("e-0"), delta("e-1"), 'event: reconnect\ndata: {"reason":"token_expired"}\n\n'], "hang"))
      .mockResolvedValueOnce(respond([delta("e-2"), 'event: resync\ndata: {"reason":"slow"}\n\n'], "hang"))
      .mockImplementation((_url, init: RequestInit) => Promise.resolve(respond([snapshot("f-0")], "hang", init.signal ?? undefined)));
    const heard = listen();

    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(headersOf(1).get("Last-Event-ID")).toBe("e-1");
    expect(headersOf(2).has("Last-Event-ID")).toBe(false);
    expect(heard.events.map((event) => event.kind)).toEqual(["snapshot", "delta", "reconnect", "delta", "resync", "snapshot"]);
    heard.stream.close();
  });

  it("an error event ends the stream for good and says why", async () => {
    fetchMock.mockResolvedValue(respond(['event: error\ndata: {"error":{"code":"forbidden","message":"No longer allowed."}}\n\n'], "hang"));
    const heard = listen();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(heard.failures).toEqual([{ code: "forbidden", message: "No longer allowed.", retryable: false, operationId: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a refusal before the stream starts is reported and not tried again", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "live_unavailable", message: "Busy.", retryable: true } }), { status: 503, headers: { "content-type": "application/json" } }),
    );
    const heard = listen();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(heard.failures.map((error) => error.code)).toEqual(["live_unavailable"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a connection that goes silent for three keep-alive periods is dropped and taken up again", async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => Promise.resolve(respond([snapshot("e-0")], "hang", init.signal ?? undefined)));
    const heard = listen();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(headersOf(1).get("Last-Event-ID")).toBe("e-0");
    heard.stream.close();
  });

  it("closing stops it and nothing is delivered afterwards", async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => Promise.resolve(respond([], "hang", init.signal ?? undefined)));
    const heard = listen();
    await vi.advanceTimersByTimeAsync(100);

    heard.stream.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(heard.failures).toEqual([]);
  });
});
