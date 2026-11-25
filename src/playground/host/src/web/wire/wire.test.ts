import { describe, expect, it } from "vitest";
import { toDebugEvent } from "@playground/contracts";
import type { DebugEvent } from "@playground/contracts";
import { MAX_EVENTS, createWire, newSid } from "./wire";

const event = (seq: number, hop: DebugEvent["hop"] = "view-host", message: unknown = { jsonrpc: "2.0", method: "n" }, at = seq) =>
  toDebugEvent({ seq, at, sid: "tab-aaaaaaaa", hop, from: hop === "view-host" ? "view" : "host", to: hop === "view-host" ? "host" : "server" }, message);

function setup() {
  const listeners: Record<string, (message: unknown) => void> = {};
  const urls: string[] = [];
  const logged: string[] = [];
  const wire = createWire({
    sid: "tab-aaaaaaaa",
    openFeed: (url) => {
      urls.push(url);
      return { addEventListener: (name: string, listener: (message: unknown) => void) => void (listeners[name] = listener), close: () => {} } as never;
    },
    log: (line) => logged.push(line),
  });
  const push = (e: DebugEvent) => listeners.wire!({ data: JSON.stringify(e) });
  return { wire, urls, logged, push };
}

describe("wire", () => {
  it("opens the feed of its tab", () => {
    expect(setup().urls).toEqual(["/debug/stream?sid=tab-aaaaaaaa"]);
  });

  it("keeps recorded and fed events in arrival order and writes a console line for each", () => {
    const { wire, push, logged } = setup();
    wire.record(event(1));
    push(event(1, "host-server"));
    wire.record(event(2));
    expect(wire.events().map((e) => e.id)).toEqual(["v-1", "s-1", "v-2"]);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatch(/^\[wire] view → host +notification/);
  });

  it("pairs the browser's replies with their requests", () => {
    const { wire } = setup();
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hello_show" } };
    wire.record(toDebugEvent({ seq: 1, at: 100, sid: "s", hop: "view-host", from: "view", to: "host", trace: "t-1" }, request));
    wire.record(toDebugEvent({ seq: 2, at: 130, sid: "s", hop: "view-host", from: "host", to: "view" }, { jsonrpc: "2.0", id: 1, result: {} }));
    expect(wire.events()[1]).toMatchObject({ tool: "hello_show", trace: "t-1", durationMs: 30 });
  });

  it("notifies subscribers until they leave", () => {
    const { wire } = setup();
    let calls = 0;
    const leave = wire.subscribe(() => calls++);
    wire.record(event(1));
    leave();
    wire.record(event(2));
    expect(calls).toBe(1);
  });

  it("changes the list reference only when the list changes, for useSyncExternalStore", () => {
    const { wire } = setup();
    const before = wire.events();
    expect(wire.events()).toBe(before);
    wire.record(event(1));
    expect(wire.events()).not.toBe(before);
  });

  it("holds events aside while paused and adds them on resume", () => {
    const { wire, push } = setup();
    wire.record(event(1));
    wire.setPaused(true);
    wire.record(event(2));
    push(event(1, "host-server"));
    expect(wire.events().map((e) => e.id)).toEqual(["v-1"]);
    wire.setPaused(false);
    expect(wire.events().map((e) => e.id)).toEqual(["v-1", "v-2", "s-1"]);
  });

  it("clear empties the list and what is held", () => {
    const { wire } = setup();
    wire.record(event(1));
    wire.setPaused(true);
    wire.record(event(2));
    wire.clear();
    wire.setPaused(false);
    expect(wire.events()).toEqual([]);
  });

  it(`keeps the newest ${MAX_EVENTS}`, () => {
    const { wire } = setup();
    for (let i = 1; i <= MAX_EVENTS + 5; i++) wire.record(event(i));
    expect(wire.events()).toHaveLength(MAX_EVENTS);
    expect(wire.events()[0]!.seq).toBe(6);
  });

  it.each([
    ["a replayed event", () => [event(1, "host-server"), event(1, "host-server")], 1],
    ["an event of the wrong shape", () => [{ nope: true } as never], 0],
  ])("takes %s from the feed once or not at all", (_name, make, count) => {
    const { wire, push } = setup();
    make().forEach(push);
    expect(wire.events()).toHaveLength(count);
  });

  it("ignores feed data that is not JSON", () => {
    const { wire } = setup();
    expect(() => {
      const listeners: ((m: unknown) => void)[] = [];
      createWire({ sid: "tab-aaaaaaaa", openFeed: () => ({ addEventListener: (_: string, l: never) => void listeners.push(l), close: () => {} }) as never });
      listeners[0]!({ data: "{" });
    }).not.toThrow();
    expect(wire.events()).toEqual([]);
  });
});

describe("newSid", () => {
  it("matches what the host server accepts", () => {
    expect(newSid()).toMatch(/^[a-z0-9-]{8,40}$/);
  });
});
