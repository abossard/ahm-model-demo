import { describe, expect, it } from "vitest";
import { parseActivityEvent, presentActivity } from "./activity";
import type { ActivityEvent } from "./types";

function event(kind: ActivityEvent["kind"], summary: string, payload: ActivityEvent["payload"] = {}): ActivityEvent {
  return { seq: 1, ts: "2026-11-10T10:00:00Z", kind, summary, payload };
}

describe("presentActivity", () => {
  it.each([
    {
      name: "a status",
      input: event("status", "Review task started"),
      expected: { icon: "status", tone: "neutral", title: "Review task started", detail: null, announcement: "Review task started" },
    },
    {
      name: "a result",
      input: event("result", "Result accepted (diff, 4 changes)", { resultKind: "diff" }),
      expected: { icon: "result", tone: "success", title: "Result accepted (diff, 4 changes)", detail: null, announcement: "Result accepted (diff, 4 changes)" },
    },
    {
      name: "an error with a message",
      input: event("error", "The agent failed.", { code: "agent_failed", message: "Quota exceeded." }),
      expected: { icon: "error", tone: "danger", title: "The agent failed.", detail: "Quota exceeded.", announcement: "Task failed: The agent failed." },
    },
    {
      name: "an error with problems",
      input: event("error", "The result is not valid", { problems: ["changes[0]: bad", "changes[1]: worse"] }),
      expected: { icon: "error", tone: "danger", title: "The result is not valid", detail: "changes[0]: bad\nchanges[1]: worse", announcement: "Task failed: The result is not valid" },
    },
  ])("presents $name", ({ input, expected }) => {
    expect(presentActivity(input)).toEqual(expected);
  });

  it.each([
    { name: "a tool call", input: event("tool_call", "List health models", { arguments: '{"a":1}' }), icon: "tool" },
    { name: "a successful tool result", input: event("tool_result", "List: ok, 1 KB", { ok: true }), icon: "toolOk" },
    { name: "a failed tool result", input: event("tool_result", "List: failed", { ok: false }), icon: "toolFailed" },
    { name: "agent text", input: event("text", "I will start", { text: "I will start\nwith the model" }), icon: "text" },
  ])("never announces $name", ({ input, icon }) => {
    const shown = presentActivity(input);
    expect([shown.icon, shown.announcement]).toEqual([icon, null]);
  });

  it.each([
    { name: "formats tool arguments as indented JSON", input: event("tool_call", "x", { arguments: '{"b":{"c":1}}' }), detail: '{\n  "b": {\n    "c": 1\n  }\n}' },
    { name: "keeps arguments that are not JSON", input: event("tool_call", "x", { arguments: "plain" }), detail: "plain" },
    { name: "shows no detail when a call has no arguments", input: event("tool_call", "x"), detail: null },
    { name: "shows the full text when it says more than the summary", input: event("text", "Line", { text: "Line\nmore" }), detail: "Line\nmore" },
    { name: "hides the text when it equals the summary", input: event("text", "Same", { text: "Same" }), detail: null },
    { name: "lists why a submission was rejected", input: event("tool_result", "rejected", { ok: false, problems: ["p1"] }), detail: "p1" },
  ])("$name", ({ input, detail }) => {
    expect(presentActivity(input).detail).toBe(detail);
  });

  it("clips very long details", () => {
    const shown = presentActivity(event("text", "Long", { text: `Long\n${"x".repeat(5000)}` }));
    expect(shown.detail).toHaveLength(2003);
    expect(shown.detail?.endsWith("...")).toBe(true);
  });
});

describe("parseActivityEvent", () => {
  const wire = { seq: 3, ts: "2026-11-10T10:00:00Z", kind: "tool_call", summary: "List", payload: { name: "x" } };

  it.each([
    { name: "JSON text", input: JSON.stringify(wire), expected: wire },
    { name: "a parsed object", input: wire, expected: wire },
    { name: "an event without a payload", input: { ...wire, payload: undefined }, expected: { ...wire, payload: {} } },
    { name: "an event whose payload is a list", input: { ...wire, payload: [1] }, expected: { ...wire, payload: {} } },
  ])("reads $name", ({ input, expected }) => {
    expect(parseActivityEvent(input)).toEqual(expected);
  });

  it.each([
    { name: "text that is not JSON", input: "nope" },
    { name: "null", input: null },
    { name: "a list", input: [] },
    { name: "a sequence of zero", input: { ...wire, seq: 0 } },
    { name: "a fractional sequence", input: { ...wire, seq: 1.5 } },
    { name: "a missing timestamp", input: { ...wire, ts: undefined } },
    { name: "an unknown kind", input: { ...wire, kind: "thinking" } },
    { name: "a summary that is not text", input: { ...wire, summary: 7 } },
  ])("refuses $name", ({ input }) => {
    expect(parseActivityEvent(input)).toBeNull();
  });
});
