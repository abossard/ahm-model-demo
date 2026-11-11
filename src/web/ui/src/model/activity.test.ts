import { describe, expect, it } from "vitest";
import { parseActivityEvent, plainStep, presentActivity } from "./activity";
import type { ActivityEvent } from "./types";

function event(kind: ActivityEvent["kind"], summary: string, payload: ActivityEvent["payload"] = {}): ActivityEvent {
  return { seq: 1, ts: "2026-11-10T10:00:00Z", kind, summary, payload };
}

describe("presentActivity", () => {
  it.each([
    {
      name: "a status the app words as the agent",
      input: event("status", "Agent started"),
      expected: { icon: "status", tone: "neutral", title: "The assistant started working", detail: null, announcement: "The assistant started working" },
    },
    {
      name: "a status that is already plain",
      input: event("status", "Reading the Base model"),
      expected: { icon: "status", tone: "neutral", title: "Reading the Base model", detail: null, announcement: "Reading the Base model" },
    },
    {
      name: "an accepted diff",
      input: event("result", "Result accepted (diff, 4 changes)", { resultKind: "diff" }),
      expected: { icon: "result", tone: "success", title: "The proposed changes are ready (4)", detail: null, announcement: "The proposed changes are ready (4)" },
    },
    {
      name: "an accepted explanation",
      input: event("result", "Result accepted (explain, 3 causes)", { resultKind: "explain" }),
      expected: { icon: "result", tone: "success", title: "The answer is ready", detail: null, announcement: "The answer is ready" },
    },
    {
      name: "an error with a message",
      input: event("error", "The agent failed.", { code: "agent_failed", message: "Quota exceeded." }),
      expected: { icon: "error", tone: "danger", title: "The agent failed.", detail: "Quota exceeded.", announcement: "The assistant stopped: The agent failed." },
    },
    {
      name: "an error with problems",
      input: event("error", "The result is not valid", { problems: ["changes[0]: bad", "changes[1]: worse"] }),
      expected: { icon: "error", tone: "danger", title: "The result is not valid", detail: "changes[0]: bad\nchanges[1]: worse", announcement: "The assistant stopped: The result is not valid" },
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

  // The titles the app gives tool calls (activity.py) read as what the assistant does; the tool stays in the details.
  it.each([
    { call: "Load skill healthmodel-analyze", doing: "Loading the analysis method", done: "Loaded the analysis method", failed: "Could not load the analysis method" },
    { call: "Read skill resource healthmodel-analyze/references/x.md", doing: "Reading the analysis guidance", done: "Read the analysis guidance", failed: "Could not read the analysis guidance" },
    { call: "Run shell: python check.py", doing: "Running a helper script", done: "Ran a helper script", failed: "A helper script failed" },
    { call: "Submit result (explain, 3 causes)", doing: "Writing the answer", done: "Wrote the answer", failed: "The answer was not accepted" },
    { call: "Submit result (diff, 5 changes)", doing: "Writing the proposed changes", done: "Wrote 5 proposed changes", failed: "The proposed changes were not accepted" },
    { call: "Submit result (diff, 1 changes)", doing: "Writing the proposed changes", done: "Wrote 1 proposed change", failed: "The proposed changes were not accepted" },
    { call: "List health models", doing: "Listing the health models", done: "Listed the health models", failed: "Could not list the health models" },
    { call: "Get health model hm-demo", doing: "Reading the health model hm-demo", done: "Read the health model hm-demo", failed: "Could not read the health model hm-demo" },
    { call: "Inspect health model hm-demo (entity svc-c, walk down)", doing: "Reading the health model hm-demo, starting at svc-c (down)", done: "Read the health model hm-demo, starting at svc-c (down)", failed: "Could not read the health model hm-demo" },
    { call: "Inspect health model hm-demo (entity svc-c)", doing: "Reading the health model hm-demo, starting at svc-c", done: "Read the health model hm-demo, starting at svc-c", failed: "Could not read the health model hm-demo" },
    { call: "Inspect health model hm-demo", doing: "Reading the health model hm-demo", done: "Read the health model hm-demo", failed: "Could not read the health model hm-demo" },
    { call: "List metric definitions", doing: "Looking up which metrics exist", done: "Looked up which metrics exist", failed: "Could not look up the metrics" },
    { call: "Query metrics CpuPercentage", doing: "Reading the metric CpuPercentage", done: "Read the metric CpuPercentage", failed: "Could not read the metric CpuPercentage" },
    { call: "Run log query on AppRequests", doing: "Querying the logs in AppRequests", done: "Queried the logs in AppRequests", failed: "The log query in AppRequests failed" },
    { call: "List resources in rg-demo", doing: "Listing the resources in rg-demo", done: "Listed the resources in rg-demo", failed: "Could not list the resources in rg-demo" },
    { call: "List activity log", doing: "Checking what changed in Azure", done: "Checked what changed in Azure", failed: "Could not check what changed in Azure" },
    { call: "Clone repository owner/repo", doing: "Reading the repository owner/repo", done: "Read the repository owner/repo", failed: "Could not read the repository owner/repo" },
  ])("words '$call' as what the assistant does", ({ call, doing, done, failed }) => {
    expect(presentActivity(event("tool_call", call)).title).toBe(doing);
    expect(presentActivity(event("tool_result", `${call}: ok, 1.2 KB`, { ok: true })).title).toBe(done);
    expect(presentActivity(event("tool_result", `${call}: accepted`, { ok: true })).title).toBe(done);
    expect(presentActivity(event("tool_result", `${call}: failed, 12 B`, { ok: false })).title).toBe(failed);
    expect(presentActivity(event("tool_result", `${call}: rejected (2 problems)`, { ok: false })).title).toBe(`${failed} (2 problems)`);
    expect(presentActivity(event("tool_result", `${call}: rejected (1 problems)`, { ok: false })).title).toBe(`${failed} (1 problem)`);
  });

  it.each([
    { name: "the first time the service is busy", payload: { attempt: 1, of: 5, waitSeconds: 10 }, title: "The assistant is busy, trying again (try 1 of 5, next try in 10 s)" },
    { name: "the last try, with no wait", payload: { attempt: 5, of: 5 }, title: "The assistant is busy, trying again (try 5 of 5)" },
    { name: "a busy status that carries no counts", payload: {}, title: "The assistant is busy, trying again" },
    { name: "a busy status with a full stop", payload: { attempt: 2, of: 3, waitSeconds: 20 }, title: "The assistant is busy, trying again (try 2 of 3, next try in 20 s)", summary: "The assistant is busy, trying again." },
  ])("tells $name", ({ payload, title, summary }) => {
    const shown = presentActivity(event("status", summary ?? "The assistant is busy, trying again", payload));
    expect(shown.title).toBe(title);
    expect(shown.announcement).toBe(title);
  });

  it("lists every problem of a rejected submission, up to the fifty the app keeps", () => {
    const problems = Array.from({ length: 50 }, (_, index) => `changes[${index}]: bad`);
    const shown = presentActivity(event("tool_result", "Submit result (diff, 5 changes): rejected (50 problems)", { name: "submit_result", ok: false, problems }));
    expect(shown.title).toBe("The proposed changes were not accepted (50 problems)");
    expect(shown.detail?.split("\n").filter((line) => line.startsWith("changes["))).toHaveLength(50);
  });

  it.each([
    { name: "a bare tool name", input: event("tool_call", "submit_result"), title: "Submit result" },
    { name: "a title it does not know", input: event("tool_call", "Inspect hm-demo"), title: "Inspect hm-demo" },
    { name: "a result it cannot parse", input: event("tool_result", "Inspected 6 entities", { ok: true }), title: "Inspected 6 entities" },
  ])("keeps $name readable", ({ input, title }) => {
    expect(presentActivity(input).title).toBe(title);
  });

  it.each([
    { name: "formats tool arguments as indented JSON", input: event("tool_call", "x", { arguments: '{"b":{"c":1}}' }), detail: 'Arguments:\n{\n  "b": {\n    "c": 1\n  }\n}' },
    { name: "keeps arguments that are not JSON", input: event("tool_call", "x", { arguments: "plain" }), detail: "Arguments:\nplain" },
    { name: "shows no detail when a call has nothing technical to add", input: event("tool_call", "x"), detail: null },
    { name: "names the tool and the title the app gave the step", input: event("tool_call", "Load skill healthmodel-analyze", { name: "load_skill", arguments: '{"name":"healthmodel-analyze"}' }), detail: 'Tool: load_skill\nStep: Load skill healthmodel-analyze\nArguments:\n{\n  "name": "healthmodel-analyze"\n}' },
    { name: "gives the size of what a tool answered", input: event("tool_result", "List health models: ok, 1.0 KB", { name: "monitor_healthmodels_list", size: 1024, ok: true }), detail: "Tool: monitor_healthmodels_list\nStep: List health models: ok, 1.0 KB\nSize of the answer: 1024 bytes" },
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

describe("plainStep", () => {
  it.each([
    { title: "submit_result", expected: "Submit result" },
    { title: "monitor_healthmodels_inspect", expected: "Monitor healthmodels inspect" },
    { title: "read-skill-resource", expected: "Read skill resource" },
    { title: "Submit result (explain, 3 causes)", expected: "Submit result (explain, 3 causes)" },
    { title: "Inspect hm-demo", expected: "Inspect hm-demo" },
    { title: "inspect", expected: "inspect" },
    { title: "", expected: "" },
  ])("shows '$title' as '$expected'", ({ title, expected }) => {
    expect(plainStep(title)).toBe(expected);
  });

  it.each(["tool_call", "tool_result"] as const)("applies to the title of a %s", (kind) => {
    expect(presentActivity(event(kind, "submit_result")).title).toBe("Submit result");
  });

  it("leaves a status as the agent worded it", () => {
    expect(presentActivity(event("status", "task_started")).title).toBe("task_started");
  });
});
