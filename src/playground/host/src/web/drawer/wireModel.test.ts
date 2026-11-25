import type { DebugEvent } from "@playground/contracts";
import { describe, expect, it } from "vitest";
import {
  applyFilters, arrowCaption, curlOf, flowOf, formatBytes, formatClock, formatDuration, laneSpan, NO_FILTERS,
  pairEvents, relatedTo, rowLabel, rowTiming, visibleRows, type WireFilters,
} from "./wireModel";

let seq = 0;
function ev(over: Partial<DebugEvent>): DebugEvent {
  seq += 1;
  return {
    id: over.hop === "host-server" ? `s-${seq}` : `v-${seq}`, seq, at: 1_000 + seq, sid: "sid-test-0001",
    hop: "view-host", from: "view", to: "host", kind: "request", method: "tools/call", rpcId: seq, tool: null,
    view: "hello-1", trace: null, bytes: 100, durationMs: null, http: null, truncated: false, payload: { jsonrpc: "2.0" },
    ...over,
  };
}

// One click: four messages on two hops with one trace, plus a long-poll that never answers.
function session() {
  const a = ev({ rpcId: 1, tool: "hello_ping", trace: "t-1" });
  const b = ev({ hop: "host-server", from: "host", to: "server", rpcId: 7, tool: "hello_ping", trace: "t-1" });
  const c = ev({ hop: "host-server", from: "server", to: "host", kind: "response", rpcId: 7, tool: "hello_ping", trace: "t-1", durationMs: 38 });
  const d = ev({ from: "host", to: "view", kind: "response", rpcId: 1, tool: "hello_ping", trace: "t-1", durationMs: 41 });
  const poll = ev({ hop: "host-server", from: "host", to: "server", rpcId: 8, tool: "wait_for_change", payload: { params: { name: "wait_for_change" } } });
  const note = ev({ from: "host", to: "view", kind: "notification", method: "ui/notifications/tool-result", rpcId: null });
  return { a, b, c, d, poll, note, all: [a, b, c, d, poll, note] };
}

describe("laneSpan and flowOf", () => {
  it.each([
    ["view", "host", "view-to-host", 0, 1],
    ["host", "view", "host-to-view", 1, 0],
    ["host", "server", "host-to-server", 1, 2],
    ["server", "host", "server-to-host", 2, 1],
  ] as const)("%s to %s", (from, to, flow, laneFrom, laneTo) => {
    const event = ev({ from, to });
    expect(flowOf(event)).toBe(flow);
    expect(laneSpan(event)).toEqual({ from: laneFrom, to: laneTo });
  });

  it.each([
    ["an error reply", { kind: "error" as const }],
    ["an HTTP 502", { kind: "http" as const, http: { method: "POST", path: "/mcp", status: 502, contentType: null, streamed: false } }],
  ])("%s is red whatever the direction", (_name, over) => {
    expect(flowOf(ev({ from: "server", to: "host", ...over }))).toBe("error");
  });

  it("an HTTP 405 is red, a 200 is not", () => {
    const http = (status: number) => ev({ kind: "http", from: "server", to: "host", http: { method: "GET", path: "/mcp", status, contentType: null, streamed: false } });
    expect(flowOf(http(405))).toBe("error");
    expect(flowOf(http(200))).toBe("server-to-host");
  });
});

describe("applyFilters", () => {
  const { all, a, b, c, d, poll, note } = session();
  it.each<[string, Partial<WireFilters>, DebugEvent[]]>([
    ["no filter", {}, all],
    ["hop host-server", { hop: "host-server" }, [b, c, poll]],
    ["hop view-host", { hop: "view-host" }, [a, d, note]],
    ["kind response", { kind: "response" }, [c, d]],
    ["kind notification", { kind: "notification" }, [note]],
    ["text on the tool", { text: "hello_ping" }, [a, b, c, d]],
    ["text is case blind", { text: "HELLO_PING" }, [a, b, c, d]],
    ["text on the payload", { text: "wait_for_change" }, [poll]],
    ["two terms must both match", { text: "hello_ping response" }, [c, d]],
    ["text on the rpc id", { text: "#7" }, [b, c]],
    ["this trace only", { trace: "t-1" }, [a, b, c, d]],
    ["hide long-polls", { hideLongPolls: true }, [a, b, c, d, note]],
    ["hop and text together", { hop: "view-host", text: "tool-result" }, [note]],
    ["nothing matches", { text: "zzz" }, []],
  ])("%s", (_name, filters, expected) => {
    expect(applyFilters(all, { ...NO_FILTERS, ...filters })).toEqual(expected);
  });
});

describe("pairEvents", () => {
  const { all, a, b, c, d, poll, note } = session();
  const pairing = pairEvents(all);

  it("joins each reply to its request on its own hop", () => {
    expect(pairing.replyOf.get(a.id)).toBe(d.id);
    expect(pairing.replyOf.get(b.id)).toBe(c.id);
    expect(pairing.requestOf.get(c.id)).toBe(b.id);
  });

  it("a request with no reply is pending, and a notification is not", () => {
    expect([...pairing.pending]).toEqual([poll.id]);
    expect(pairing.replyOf.has(note.id) || pairing.pending.has(note.id)).toBe(false);
  });

  it("the View and the host number their requests apart", () => {
    const fromView = ev({ rpcId: 1, from: "view", to: "host" });
    const fromHost = ev({ rpcId: 1, from: "host", to: "view" });
    const replyToHost = ev({ rpcId: 1, from: "view", to: "host", kind: "response" });
    const result = pairEvents([fromView, fromHost, replyToHost]);
    expect(result.requestOf.get(replyToHost.id)).toBe(fromHost.id);
    expect([...result.pending]).toEqual([fromView.id]);
  });

  it("the same id in another View is another request", () => {
    const one = ev({ rpcId: 5, view: "lab-1" });
    const two = ev({ rpcId: 5, view: "lab-2" });
    const reply = ev({ rpcId: 5, view: "lab-2", from: "host", to: "view", kind: "response" });
    expect(pairEvents([one, two, reply]).requestOf.get(reply.id)).toBe(two.id);
  });
});

describe("relatedTo", () => {
  const { all, a, b, c, d } = session();
  const pairing = pairEvents(all);
  it.each([
    ["a request", a, d.id, [b.id, c.id, d.id]],
    ["a reply", c, b.id, [a.id, b.id, d.id]],
  ])("%s", (_name, selected, partner, trace) => {
    const related = relatedTo(selected, all, pairing);
    expect(related.partner).toBe(partner);
    expect([...related.sameTrace].sort()).toEqual([...trace].filter((id) => id !== selected.id).sort());
  });

  it("nothing selected, nothing related", () => {
    expect(relatedTo(null, all, pairing)).toEqual({ partner: null, sameTrace: new Set() });
  });
});

describe("formatters", () => {
  it.each([[0, "0 B"], [214, "214 B"], [1023, "1023 B"], [1536, "1.5 KB"], [20_480, "20 KB"], [3 * 1024 * 1024, "3.0 MB"]])("bytes %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
  it.each([[0, "0 ms"], [38, "38 ms"], [999.6, "1000 ms"], [1200, "1.20 s"], [25_400, "25.4 s"], [125_000, "2 min 5 s"]])("duration %s", (n, text) => {
    expect(formatDuration(n)).toBe(text);
  });
  it("clock shows milliseconds", () => {
    expect(formatClock(Date.UTC(2026, 10, 25, 14, 3, 22, 481), "UTC")).toBe("14:03:22.481");
  });
  it.each([
    [ev({ method: "tools/call", tool: "checkers_move" }), { primary: "tools/call", secondary: "checkers_move" }],
    [ev({ method: null, kind: "response" }), { primary: "response", secondary: null }],
    [ev({ method: "ui/open-link", kind: "error", payload: { error: { code: -32602, message: "Only https links open." } } }), { primary: "ui/open-link", secondary: "Only https links open." }],
    [ev({ kind: "http", method: null, http: { method: "GET", path: "/mcp", status: 405, contentType: null, streamed: false } }), { primary: "GET /mcp", secondary: "405" }],
  ])("row label %#", (event, label) => {
    expect(rowLabel(event)).toEqual(label);
  });
  it("caption", () => {
    expect(arrowCaption({ from: "host", to: "server" })).toBe("host → server");
  });
  it.each([
    ["a running request", ev({}), true, 2500, "waiting 2.50 s"],
    ["a request not yet timed", ev({}), true, null, "waiting"],
    ["a reply", ev({ durationMs: 38 }), false, null, "38 ms"],
    ["a notification", ev({ durationMs: null }), false, null, null],
  ])("timing of %s", (_name, event, pending, waited, text) => {
    expect(rowTiming(event, pending, waited)).toBe(text);
  });
});

describe("curlOf", () => {
  const request = ev({ hop: "host-server", from: "host", to: "server", payload: { method: "tools/call", params: { text: "it's" } } });
  it("replays a request to the server", () => {
    const curl = curlOf(request, "http://localhost:8090");
    expect(curl?.command).toContain("curl -sN -X POST 'http://localhost:8090/mcp'");
    expect(curl?.command).toContain("-H 'x-playground-sid: sid-test-0001'");
    expect(curl?.command).toContain(`-d '{"method":"tools/call","params":{"text":"it'\\''s"}}'`);
  });
  it.each([
    ["a reply", ev({ hop: "host-server", from: "server", to: "host", kind: "response" })],
    ["a View message", ev({})],
    ["an event with no payload", ev({ hop: "host-server", payload: null })],
  ])("none for %s", (_name, event) => {
    expect(curlOf(event, "http://x")).toBeNull();
  });
});

describe("visibleRows", () => {
  it.each([[3, 5, 0], [5, 5, 0], [8, 5, 3]])("%s rows, limit %s hides %s", (count, limit, hidden) => {
    const rows = Array.from({ length: count }, (_, i) => i);
    const result = visibleRows(rows, limit);
    expect(result.hidden).toBe(hidden);
    expect(result.rows.at(-1)).toBe(count - 1);
  });
});
