import { describe, expect, it } from "vitest";
import { describeHostEvent, hostLine, pushEntry, safeLink, type HostLogEntry } from "./hostEvents";
import type { HostEvent } from "./wireApi";

const entry = (id: number, type: HostLogEntry["type"], view = "v1"): HostLogEntry => ({ id, at: id, type, view, text: type, link: null, detail: null });

describe("safeLink", () => {
  it.each([
    ["https://modelcontextprotocol.io/docs", "https://modelcontextprotocol.io/docs"],
    ["http://example.com", null],
    ["javascript:alert(1)", null],
    ["data:text/html,hi", null],
    ["not a url", null],
    ["", null],
  ])("%s", (url, expected) => {
    expect(safeLink(url)).toBe(expected);
  });
});

describe("describeHostEvent", () => {
  it.each<[HostEvent, RegExp]>([
    [{ type: "ready" }, /handshake/],
    [{ type: "size", height: 480.4 }, /480 px/],
    [{ type: "message", text: "hi" }, /message: "hi"/],
    [{ type: "context", value: { tableId: "ab12cd" } }, /tableId/],
    [{ type: "link", url: "https://example.com/x" }, /confirm/],
    [{ type: "link", url: "http://example.com" }, /refuses/],
    [{ type: "display", mode: "fullscreen" }, /fullscreen display/],
    [{ type: "log", level: "warning", data: "slow" }, /warning: slow/],
    [{ type: "error", message: "no resource" }, /no resource/],
    [{ type: "career", career: { unlocked: 2, lab: [], completed: false } }, /layer 2/],
  ])("%j", (event, pattern) => {
    expect(describeHostEvent(event).text).toMatch(pattern);
  });

  it("a long message is cut", () => {
    expect(describeHostEvent({ type: "message", text: "x".repeat(500) }).text.length).toBeLessThan(220);
  });

  it("only a https link carries an action", () => {
    expect(describeHostEvent({ type: "link", url: "https://example.com/" }).link).toBe("https://example.com/");
    expect(describeHostEvent({ type: "link", url: "http://example.com/" }).link).toBeNull();
  });
});

describe("pushEntry", () => {
  it.each([
    ["appends", [entry(1, "ready")], entry(2, "message"), [1, 2]],
    ["a size replaces a size of the same View", [entry(1, "size")], entry(2, "size"), [2]],
    ["a size of another View is kept", [entry(1, "size", "v0")], entry(2, "size"), [1, 2]],
    ["a size after a message is kept", [entry(1, "message")], entry(2, "size"), [1, 2]],
  ])("%s", (_name, log, next, ids) => {
    expect(pushEntry(log, next).map((item) => item.id)).toEqual(ids);
  });

  it("keeps the newest entries", () => {
    const log = [entry(1, "ready"), entry(2, "message"), entry(3, "log")];
    expect(pushEntry(log, entry(4, "log"), 3).map((item) => item.id)).toEqual([2, 3, 4]);
  });
});

describe("hostLine", () => {
  it.each([
    ["boot", {}, "[host] boot"],
    ["route", { to: "/lab", from: null }, "[host] route to=/lab"],
    ["career", { unlocked: 3, lab: ["log"] }, '[host] career unlocked=3 lab=["log"]'],
    ["copy", { what: "", bytes: 0 }, "[host] copy bytes=0"],
  ])("%s", (topic, fields, line) => {
    expect(hostLine(topic, fields)).toBe(line);
  });
});
