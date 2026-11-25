// @vitest-environment jsdom
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { DebugEvent } from "@playground/contracts";
import { mintTrace, tap } from "./tap";
import { createWire } from "./wire";
import type { Wire } from "./wire";

function fakeWire(): Wire & { all: DebugEvent[] } {
  const all: DebugEvent[] = [];
  return { sid: "tab-aaaaaaaa", all, events: () => all, subscribe: () => () => {}, record: (e) => void all.push(e), setPaused() {}, clear() {} };
}

const call = (id: number, params: object = {}): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "t", ...params } });

async function pair() {
  const [bridgeSide, viewSide] = InMemoryTransport.createLinkedPair();
  const wire = fakeWire();
  const tapped = tap(bridgeSide, { wire, viewId: "hello-1", now: () => 1 });
  return { wire, tapped, viewSide };
}

describe("tap", () => {
  it("records what the host sends and what the View sends, as the transport sees it", async () => {
    const { wire, tapped, viewSide } = await pair();
    const received: JSONRPCMessage[] = [];
    viewSide.onmessage = (m) => void received.push(m);
    const hostGot: JSONRPCMessage[] = [];
    tapped.onmessage = (m) => void hostGot.push(m);
    await tapped.start();
    await viewSide.start();
    await viewSide.send(call(1));
    await tapped.send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(hostGot).toEqual([call(1)]);
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    expect(wire.all.map((e) => [e.hop, e.from, e.to, e.kind, e.view, e.seq])).toEqual([
      ["view-host", "view", "host", "request", "hello-1", 1],
      ["view-host", "host", "view", "response", "hello-1", 2],
    ]);
    expect(wire.all[0]!.trace).toMatch(/^t-[0-9a-f]{12}$/);
    expect(wire.all[1]!.trace).toBe(wire.all[0]!.trace);
  });

  it("numbers events of all Views of one wire in one sequence", async () => {
    const wire = fakeWire();
    const seqs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const [a, b] = InMemoryTransport.createLinkedPair();
      const t = tap(a, { wire, viewId: `v-${i}` });
      t.onmessage = () => {};
      await t.start();
      await b.start();
      await b.send(call(1));
    }
    wire.all.forEach((e) => seqs.push(e.seq));
    expect(seqs).toEqual([1, 2]);
  });

  it("knows the trace of an open request until it is answered", async () => {
    const { tapped, viewSide } = await pair();
    tapped.onmessage = () => {};
    await tapped.start();
    await viewSide.start();
    await viewSide.send(call(7));
    const trace = tapped.traceOf(7);
    expect(trace).toBeDefined();
    await tapped.send({ jsonrpc: "2.0", id: 7, result: {} });
    expect(tapped.traceOf(7)).toBeUndefined();
  });

  it.each([
    ["progress of a call", { _meta: { progressToken: "p1" } }, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p1", progress: 1 } }, true],
    ["progress of another token", { _meta: { progressToken: "p1" } }, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p2", progress: 1 } }, false],
    ["the tool result", {}, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} }, "entry"],
    ["a host context change", {}, { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: {} }, false],
  ])("the trace of %s", async (_name, viewParams, host, expected) => {
    const { wire, tapped, viewSide } = await pair();
    tapped.onmessage = () => {};
    await tapped.start();
    await viewSide.start();
    tapped.setEntryTrace("t-entry");
    await viewSide.send(call(1, viewParams));
    await tapped.send(host as JSONRPCMessage);
    const [request, sent] = wire.all;
    expect(sent!.trace).toBe(expected === true ? request!.trace : expected === "entry" ? "t-entry" : null);
  });

  it("passes everything on when recording fails", async () => {
    const { wire, tapped, viewSide } = await pair();
    wire.record = () => { throw new Error("listener broke"); };
    const got: JSONRPCMessage[] = [];
    tapped.onmessage = (m) => void got.push(m);
    await tapped.start();
    await viewSide.start();
    await viewSide.send(call(1));
    expect(got).toHaveLength(1);
  });

  it("forwards close and error handlers to the transport", async () => {
    const { tapped, viewSide } = await pair();
    let closed = false;
    tapped.onclose = () => void (closed = true);
    await tapped.start();
    await viewSide.start();
    await viewSide.close();
    expect(closed).toBe(true);
  });
});

describe("tap with a real AppBridge and App", () => {
  it("captures a whole call: initialize, tool result, the View's tool call with progress, and its reply, with one trace per click", async () => {
    const wire = createWire({ sid: "tab-aaaaaaaa", openFeed: () => ({ addEventListener() {}, close() {} }) as never, log: () => {} });
    const [bridgeSide, viewSide] = InMemoryTransport.createLinkedPair();
    const tapped = tap(bridgeSide, { wire, viewId: "hello-1" });
    const bridge = new AppBridge(null, { name: "h", version: "1" }, { serverTools: {} }, { hostContext: { theme: "dark" } });
    let progressSent = false;
    bridge.oncalltool = async (params, extra) => {
      expect(tapped.traceOf(extra.requestId)).toMatch(/^t-/);
      (extra.sendNotification as (n: { method: string; params: unknown }) => Promise<void>)({
        method: "notifications/progress", params: { progressToken: params._meta?.progressToken, progress: 1 },
      }).then(() => void (progressSent = true), () => {});
      return { content: [{ type: "text", text: "done" }], structuredContent: { n: 1 } };
    };
    await bridge.connect(tapped);
    const app = new App({ name: "v", version: "1" }, {}, { autoResize: false });
    await app.connect(viewSide);
    tapped.setEntryTrace("t-entry");
    await bridge.sendToolInput({ arguments: { a: 1 } });
    await bridge.sendToolResult({ content: [], structuredContent: { ok: true } });
    const result = await app.callServerTool({ name: "hello_ping", arguments: {} }, { onprogress: () => {} });
    expect(result.structuredContent).toEqual({ n: 1 });
    expect(progressSent).toBe(true);

    const events = wire.events();
    const rows = events.map((e) => `${e.from}>${e.to} ${e.kind} ${e.method ?? ""}`);
    expect(rows).toEqual(expect.arrayContaining([
      "view>host request ui/initialize",
      "host>view response ui/initialize",
      "view>host notification ui/notifications/initialized",
      "host>view notification ui/notifications/tool-input",
      "host>view notification ui/notifications/tool-result",
      "view>host request tools/call",
      "host>view notification notifications/progress",
      "host>view response tools/call",
    ]));
    const toolCall = events.filter((e) => e.method === "tools/call");
    expect(toolCall).toHaveLength(2);
    expect(toolCall[0]!.trace).toBe(toolCall[1]!.trace);
    expect(toolCall[0]!.tool).toBe("hello_ping");
    expect(events.find((e) => e.method === "notifications/progress")!.trace).toBe(toolCall[0]!.trace);
    expect(events.find((e) => e.method === "ui/notifications/tool-result")!.trace).toBe("t-entry");
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });
});

describe("mintTrace", () => {
  it("is 12 hex digits after t-", () => {
    expect(mintTrace()).toMatch(/^t-[0-9a-f]{12}$/);
  });
});
