import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ago, secondsLeft } from "./clock";
import { outputOf, textOf } from "./call";
import { followTable, pollDelayMs, retryDelayMs, takeSnapshot } from "./live";
import { logRecord } from "./log";
import { fixtureApp } from "./testing";
import { withTransition } from "./transition";

const snap = (tableId: string, version: number) => ({ tableId, version });

describe("takeSnapshot", () => {
  it.each([
    ["first snapshot", null, snap("c1", 1), snap("c1", 1)],
    ["newer", snap("c1", 1), snap("c1", 2), snap("c1", 2)],
    ["same version", snap("c1", 2), snap("c1", 2), snap("c1", 2)],
    ["older", snap("c1", 3), snap("c1", 2), snap("c1", 3)],
    ["another table, lower version", snap("c1", 9), snap("c2", 1), snap("c2", 1)],
    ["table gone", snap("c1", 9), null, null],
  ])("%s", (_name, current, incoming, expected) => {
    expect(takeSnapshot(current, incoming)).toEqual(expected);
  });
});

describe("delays", () => {
  it.each([[0, 0], [1, 1000], [2, 2000], [3, 5000], [9, 5000]])("retry after %i failures waits %i ms", (failures, ms) => {
    expect(retryDelayMs(failures)).toBe(ms);
  });
  it.each([
    [true, 5, 0],
    [false, 25_000, 0],
    [false, 40, 1000],
    [false, 999, 1000],
  ])("changed %s after %i ms waits %i ms", (changed, elapsedMs, ms) => {
    expect(pollDelayMs({ changed, elapsedMs })).toBe(ms);
  });
});

describe("clock", () => {
  it.each([
    ["no skew", 100_000, 40_000, 40_000, 40_000, 60],
    ["server ahead by 5 s", 100_000, 45_000, 40_000, 40_000, 55],
    ["time passes", 100_000, 40_000, 40_000, 70_000, 30],
    ["past the deadline", 100_000, 40_000, 40_000, 150_000, 0],
  ])("secondsLeft, %s", (_name, deadline, serverTime, receivedAt, now, expected) => {
    expect(secondsLeft(deadline, serverTime, receivedAt, now)).toBe(expected);
  });
  it.each([[1_000, "just now"], [120_000, "2 min ago"], [3 * 3_600_000, "3 h ago"]])("ago %i ms", (age, text) => {
    expect(ago(0, age)).toBe(text);
  });
});

describe("results", () => {
  const ok: CallToolResult = { content: [{ type: "text", text: "fine" }], structuredContent: { n: 1 } };
  it.each([
    ["structured output", ok, { n: 1 }, null],
    ["server error", { isError: true, content: [{ type: "text", text: "The table store is not ready." }] }, null, "The table store is not ready."],
    ["error without text", { isError: true, content: [] }, null, "The server could not complete the call."],
    ["no structured content", { content: [] }, null, "without structured content"],
  ] as [string, unknown, unknown, string | null][])("%s", (_name, result, output, message) => {
    if (message) expect(() => outputOf(result as CallToolResult, "hello_ping")).toThrow(message);
    else expect(outputOf(result as CallToolResult, "hello_ping")).toEqual(output);
  });
  it("textOf reads the first text block", () => expect(textOf(ok)).toBe("fine"));
});

describe("log", () => {
  it("one record carries the View, the level and the fields", () => {
    expect(logRecord("lab", "info", "call", { tool: "lab_echo" }, 0)).toEqual({
      t: "1970-01-01T00:00:00.000Z", level: "info", view: "lab", msg: "call", tool: "lab_echo",
    });
  });
});

describe("followTable", () => {
  const player = { id: "p-00000000", handle: "Neon Rook" };
  const view = (version: number) => ({ tableId: "c00000000", game: "checkers" as const, version, serverTime: 0, view: {} });

  it("asks again with the newest version, delivers each change and stops when the table is gone", async () => {
    const asked: number[] = [];
    const answers = [
      { changed: true, snapshot: view(2), notice: null },
      { changed: true, snapshot: view(3), notice: null },
      { changed: true, snapshot: null, notice: { code: "table_gone" as const, message: "The table closed." } },
    ];
    const app = fixtureApp({
      wait_for_change: (args) => { asked.push(args.sinceVersion); return answers.shift()! as never; },
    });
    // The caller's version never moves: the loop must not ask for the same version twice.
    const delivered: (number | null)[] = [];
    await followTable({
      app, player, tableId: "c00000000", version: () => 1, signal: new AbortController().signal,
      onChange: (snapshot) => { delivered.push(snapshot?.version ?? null); },
      onOffline: () => {},
    });
    expect(asked).toEqual([1, 2, 3]);
    expect(delivered).toEqual([2, 3, null]);
  });

  it("goes offline on a failure, backs off, and recovers", async () => {
    const stop = new AbortController();
    let calls = 0;
    const app = fixtureApp({
      wait_for_change: () => {
        calls += 1;
        if (calls === 1) throw new Error("network");
        stop.abort();
        return { changed: false, snapshot: null, notice: null } as never;
      },
    });
    const offline: boolean[] = [];
    const sleeps: number[] = [];
    await followTable({
      app, player, tableId: "c00000000", version: () => 1, signal: stop.signal,
      onChange: () => {}, onOffline: (value) => offline.push(value),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(offline).toEqual([true]);
    expect(sleeps).toEqual([1000]);
  });
});

describe("withTransition", () => {
  it.each([
    ["the API exists and motion is allowed", true, false, 1],
    ["reduced motion", true, true, 0],
    ["no API", false, false, 0],
  ])("%s", (_name, hasApi, reduced, started) => {
    let applied = 0;
    let startedCount = 0;
    const doc = hasApi ? { startViewTransition: (update: () => void) => { startedCount += 1; update(); } } : {};
    withTransition(() => { applied += 1; }, doc, reduced);
    expect([applied, startedCount]).toEqual([1, started]);
  });
});
