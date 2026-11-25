import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  advanceCareer, classify, clip, createPairing, NEW_CAREER, newPlayer, Player, START_BOARD, Board, toDebugEvent,
  TOOL_NAMES, toolMeta, TOOLS, VIEWS, wireLine, type Career, type CareerEvent, type DebugEvent,
} from "./index";

describe("advanceCareer", () => {
  const lab = (exhibit: "call_tool" | "progress" | "log"): CareerEvent => ({ type: "lab_exhibit", exhibit });
  it.each<[string, CareerEvent[], Partial<Career>]>([
    ["a ping opens the lab", [{ type: "hello_ping" }], { unlocked: 2 }],
    ["two exhibits are not enough", [lab("call_tool"), lab("progress")], { unlocked: 1 }],
    ["the same exhibit counts once", [lab("log"), lab("log"), lab("log")], { unlocked: 1 }],
    ["three exhibits open checkers", [lab("call_tool"), lab("progress"), lab("log")], { unlocked: 3 }],
    ["a capture opens the trader", [{ type: "checkers_capture" }], { unlocked: 4 }],
    ["a profit opens blackjack", [{ type: "trader_profit" }], { unlocked: 5 }],
    ["a win completes the career", [{ type: "blackjack_win" }], { unlocked: 5, completed: true }],
    ["the cheat opens everything", [{ type: "cheat" }], { unlocked: 5, completed: false }],
    ["a layer never locks again", [{ type: "cheat" }, { type: "hello_ping" }], { unlocked: 5 }],
  ])("%s", (_name, events, expected) => {
    expect(events.reduce(advanceCareer, NEW_CAREER)).toMatchObject(expected);
  });

  it("returns the same object when nothing changes", () => {
    const career = advanceCareer(NEW_CAREER, { type: "cheat" });
    expect(advanceCareer(career, { type: "hello_ping" })).toBe(career);
  });
});

describe("tool catalog", () => {
  it.each(TOOL_NAMES)("%s has an object input, an object output and JSON Schemas", (name) => {
    const spec = TOOLS[name];
    expect(z.toJSONSchema(spec.input)).toMatchObject({ type: "object" });
    expect(z.toJSONSchema(spec.output)).toMatchObject({ type: "object" });
    expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
  });

  it.each(TOOL_NAMES.filter((name) => TOOLS[name].view))("%s points at its View", (name) => {
    expect(toolMeta(name).ui.resourceUri).toBe(VIEWS[TOOLS[name].view!]);
  });

  it("every View has exactly one tool a model may call", () => {
    for (const view of Object.keys(VIEWS)) {
      const entries = TOOL_NAMES.filter((name) => TOOLS[name].view === view && TOOLS[name].visibility.includes("model"));
      expect(entries, view).toHaveLength(1);
    }
  });
});

describe("classify", () => {
  it.each<[string, unknown, object]>([
    ["request", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { kind: "request", method: "tools/list", rpcId: 1 }],
    ["tool call with a trace", { jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "hello_ping", _meta: { "playground/trace": "t1" } } },
      { kind: "request", tool: "hello_ping", trace: "t1", rpcId: "a" }],
    ["notification", { jsonrpc: "2.0", method: "ui/notifications/initialized" }, { kind: "notification", rpcId: null }],
    ["response", { jsonrpc: "2.0", id: 1, result: {} }, { kind: "response", method: null }],
    ["error", { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x" } }, { kind: "error" }],
    ["not an object", "nonsense", { kind: "response", rpcId: null }],
  ])("%s", (_name, message, expected) => {
    expect(classify(message)).toMatchObject(expected);
  });
});

describe("wire events", () => {
  const base = { sid: "tab1", hop: "host-server", view: null } as const;
  const request = toDebugEvent({ ...base, seq: 1, at: 1000, from: "host", to: "server" },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "checkers_move", _meta: { "playground/trace": "t9" } } });
  const response = toDebugEvent({ ...base, seq: 2, at: 1042, from: "server", to: "host" }, { jsonrpc: "2.0", id: 7, result: {} });

  it("pairs a response with its request", () => {
    const pair = createPairing();
    pair(request);
    expect(pair(response)).toMatchObject({ method: "tools/call", tool: "checkers_move", trace: "t9", durationMs: 42 });
  });

  it("keeps the id spaces of the two ends apart", () => {
    const pair = createPairing();
    pair(request);
    const other: DebugEvent = { ...response, from: "host", to: "server" };
    expect(pair(other).durationMs).toBeNull();
  });

  it("writes one line per message", () => {
    expect(wireLine(createPairing()(request))).toBe(
      "[wire] host → server request      tools/call(checkers_move) #7 " + `${request.bytes}B trace=t9 sid=tab1`);
  });

  it.each<[string, unknown, boolean]>([
    ["short strings stay", { text: "hello" }, false],
    ["a View document is shortened", { contents: [{ text: "x".repeat(5000) }] }, true],
  ])("clip: %s", (_name, payload, truncated) => {
    const clipped = clip(payload);
    expect(clipped.truncated).toBe(truncated);
    expect(JSON.stringify(clipped.payload).length).toBeLessThan(400);
  });
});

describe("primitives", () => {
  it("makes a valid player from random bytes", () => {
    expect(Player.safeParse(newPlayer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).success).toBe(true);
  });
  it("starts checkers with twelve pieces a side", () => {
    expect(Board.safeParse(START_BOARD).success).toBe(true);
    expect([...START_BOARD].filter((piece) => piece === "b")).toHaveLength(12);
    expect([...START_BOARD].filter((piece) => piece === "w")).toHaveLength(12);
  });
});
