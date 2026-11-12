import { describe, expect, it } from "vitest";
import {
  askedMoment,
  buildTaskInput,
  designModelOf,
  expectedDuration,
  finishedAnnouncement,
  hasRunningTask,
  inputOfTask,
  instructionProblem,
  NO_DESIGN_MODEL,
  repositoryProblem,
  resultHeading,
  stateSentence,
  targetLabel,
  taskLabel,
  taskTitle,
  type TaskContext,
  type TaskDraft,
  waitingHint,
} from "./tasks";
import type { ExplainResult, ModelCatalog, ModelRef, Task, TaskSummary } from "./types";

function model(name: string, resourceGroup = "rg-app", subscriptionId = "sub-1"): ModelRef {
  return { id: null, name, resourceGroup, subscriptionId, location: null, provisioningState: null };
}

const APP = model("hm-demo");
const DESIGN = model("hm-demo-design");
const CATALOG: ModelCatalog = {
  models: [APP, DESIGN, model("hm-other", "rg-other")],
  default: { name: "hm-demo", resourceGroup: "rg-app", subscriptionId: "sub-1" },
};
const CONTEXT: TaskContext = { selected: model("hm-other", "rg-other"), entity: "svc-a", catalog: CATALOG };
const draft = (patch: Partial<TaskDraft>): TaskDraft => ({ type: "review", instruction: "", repositoryUrl: "", ...patch });

describe("repositoryProblem", () => {
  it.each([
    { url: "", valid: true },
    { url: "  ", valid: true },
    { url: "https://github.com/octo/repo", valid: true },
    { url: "https://github.com/octo/repo.git", valid: true },
    { url: "https://github.com/octo/repo/", valid: true },
    { url: " https://github.com/octo/my-repo_2.x ", valid: true },
    { url: "http://github.com/octo/repo", valid: false },
    { url: "https://gitlab.com/octo/repo", valid: false },
    { url: "https://github.com/octo", valid: false },
    { url: "https://github.com/octo/repo/tree/main", valid: false },
    { url: "https://github.com.evil.io/octo/repo", valid: false },
    { url: "github.com/octo/repo", valid: false },
    { url: `https://github.com/${"o".repeat(39)}/repo`, valid: true },
    { url: `https://github.com/${"o".repeat(40)}/repo`, valid: false },
    { url: `https://github.com/octo/${"r".repeat(100)}`, valid: true },
    { url: `https://github.com/octo/${"r".repeat(101)}`, valid: false },
    { url: "https://github.com/oc_to/repo", valid: false },
    { url: "https://github.com/-octo/repo", valid: false },
    { url: "https://github.com/octo/.repo", valid: false },
    { url: "https://github.com/octo/-repo", valid: false },
  ])("accepts '$url': $valid", ({ url, valid }) => {
    expect(repositoryProblem(url) === null).toBe(valid);
  });
});

describe("instructionProblem", () => {
  it.each([
    { length: 0, valid: true },
    { length: 2000, valid: true },
    { length: 2001, valid: false },
  ])("accepts $length characters: $valid", ({ length, valid }) => {
    expect(instructionProblem("x".repeat(length)) === null).toBe(valid);
  });
});

describe("designModelOf", () => {
  it.each([
    { name: "the default model's design twin", catalog: CATALOG, expected: DESIGN },
    { name: "a catalog without it", catalog: { ...CATALOG, models: [APP] }, expected: null },
    { name: "a twin in another group", catalog: { ...CATALOG, models: [APP, model("hm-demo-design", "rg-other")] }, expected: null },
    { name: "no catalog", catalog: null, expected: null },
  ])("finds $name", ({ catalog, expected }) => {
    expect(designModelOf(catalog)).toEqual(expected);
  });
});

describe("buildTaskInput", () => {
  it("reviews the model on screen", () => {
    expect(buildTaskInput(draft({ instruction: "  look closer  " }), CONTEXT)).toEqual({
      problem: null,
      input: {
        type: "review",
        target: { name: "hm-other", resourceGroup: "rg-other", subscriptionId: "sub-1" },
        instruction: "look closer",
      },
    });
  });

  it("explains the selected entity of the model on screen", () => {
    expect(buildTaskInput(draft({ type: "explain" }), CONTEXT).input).toEqual({
      type: "explain",
      target: { name: "hm-other", resourceGroup: "rg-other", subscriptionId: "sub-1", entity: "svc-a" },
      instruction: "",
    });
  });

  const MOMENT = Date.parse("2026-11-11T23:40:00.250Z");
  it.each([
    { name: "an Explain asks about the past moment the page shows", type: "explain" as const, moment: MOMENT, asOf: "2026-11-11T23:40:00.250Z" },
    { name: "an Explain at now names no moment", type: "explain" as const, moment: null, asOf: undefined },
    { name: "a Review is about now, whatever the page shows", type: "review" as const, moment: MOMENT, asOf: undefined },
    { name: "a Design is about now, whatever the page shows", type: "design" as const, moment: MOMENT, asOf: undefined },
  ])("$name", ({ type, moment, asOf }) => {
    const { input } = buildTaskInput(draft({ type }), { ...CONTEXT, moment });

    expect(input?.type).toBe(type);
    expect(input?.asOf).toBe(asOf);
    expect(input !== null && "asOf" in input).toBe(asOf !== undefined);
  });

  it("designs against the design model with the default resource group as Workload", () => {
    expect(
      buildTaskInput(draft({ type: "design", repositoryUrl: " https://github.com/octo/repo " }), CONTEXT).input,
    ).toEqual({
      type: "design",
      target: { name: "hm-demo-design", resourceGroup: "rg-app", subscriptionId: "sub-1" },
      workload: { resourceGroup: "rg-app", repositoryUrl: "https://github.com/octo/repo" },
      instruction: "",
    });
  });

  it("leaves the repository out of the Workload when there is none", () => {
    expect(buildTaskInput(draft({ type: "design" }), CONTEXT).input?.workload).toEqual({ resourceGroup: "rg-app" });
  });

  it.each([
    { name: "an explain without an entity", draft: draft({ type: "explain" }), context: { ...CONTEXT, entity: null }, problem: "Select an entity in the graph first." },
    { name: "a review without a model", draft: draft({}), context: { ...CONTEXT, selected: null }, problem: "Choose a health model first." },
    { name: "a design without a design model", draft: draft({ type: "design" }), context: { ...CONTEXT, catalog: { ...CATALOG, models: [APP] } }, problem: NO_DESIGN_MODEL },
    { name: "a design without a catalog", draft: draft({ type: "design" }), context: { ...CONTEXT, catalog: null }, problem: "The health models are still loading." },
    { name: "a bad repository", draft: draft({ type: "design", repositoryUrl: "nope" }), context: CONTEXT, problem: "Enter a public GitHub repository, such as https://github.com/owner/repository." },
    { name: "a long instruction", draft: draft({ instruction: "x".repeat(2001) }), context: CONTEXT, problem: "Keep the note to 2000 characters." },
  ])("refuses $name", ({ draft: input, context, problem }) => {
    expect(buildTaskInput(input, context)).toEqual({ input: null, problem });
  });
});

describe("task helpers", () => {
  const task = (status: TaskSummary["status"]): TaskSummary => ({
    id: "1", sessionId: "s", seq: 1, type: "review", target: APP, instruction: "", status, createdAt: "2026-11-10T10:00:00Z",
  });

  it.each([
    { statuses: [], running: false },
    { statuses: ["done", "failed"], running: false },
    { statuses: ["done", "running"], running: true },
    { statuses: ["queued"], running: true },
  ] as const)("hasRunningTask($statuses) is $running", ({ statuses, running }) => {
    expect(hasRunningTask(statuses.map(task))).toBe(running);
  });

  it.each([
    ["review", "Model check"],
    ["explain", "Explanation"],
    ["design", "Design"],
  ] as const)("labels %s as %s", (type, label) => {
    expect(taskLabel(type)).toBe(label);
  });

  it.each([
    { target: APP, expected: "hm-demo (rg-app)" },
    { target: { ...APP, entity: "svc-a" }, expected: "hm-demo (rg-app)" },
  ])("labels the model of a target as $expected", ({ target, expected }) => {
    expect(targetLabel(target)).toBe(expected);
  });
});

describe("inputOfTask", () => {
  const target = { name: "hm-z", resourceGroup: "rg-z", subscriptionId: "sub-z" };
  it.each([
    { name: "an Explain", task: { type: "explain" as const, target: { ...target, entity: "db" }, instruction: "why" }, expected: { type: "explain", target: { ...target, entity: "db" }, instruction: "why" } },
    { name: "a Design with its repository", task: { type: "design" as const, target, workload: { resourceGroup: "rg-z", repositoryUrl: "https://github.com/o/r" }, instruction: "" }, expected: { type: "design", target, workload: { resourceGroup: "rg-z", repositoryUrl: "https://github.com/o/r" }, instruction: "" } },
    { name: "a Review without a workload", task: { type: "review" as const, target, instruction: "" }, expected: { type: "review", target, instruction: "" } },
    { name: "an Explain about a past moment, about that moment", task: { type: "explain" as const, target: { ...target, entity: "db" }, instruction: "", asOf: "2026-11-11T23:40:00Z" }, expected: { type: "explain", target: { ...target, entity: "db" }, instruction: "", asOf: "2026-11-11T23:40:00Z" } },
  ])("asks for $name again as it was asked", ({ task, expected }) => {
    expect(inputOfTask(task)).toEqual(expected);
  });
});

describe("expectedDuration and waitingHint", () => {
  const taskOfSpan = (seq: number, type: Task["type"], status: Task["status"], seconds: number | null): TaskSummary => ({
    id: String(seq),
    sessionId: "s",
    seq,
    type,
    target: { name: "m", resourceGroup: "r", subscriptionId: "s" },
    instruction: "",
    status,
    createdAt: "2026-11-11T14:00:00Z",
    ...(seconds === null ? {} : { finishedAt: new Date(Date.parse("2026-11-11T14:00:00Z") + seconds * 1000).toISOString() }),
  });
  const seconds = (milliseconds: number): string => `${milliseconds / 1000} s`;

  it.each([
    { name: "no Tasks", tasks: [], expected: null },
    { name: "only a Task of another type", tasks: [taskOfSpan(1, "review", "done", 90)], expected: null },
    { name: "only a failed Task", tasks: [taskOfSpan(1, "explain", "failed", 5)], expected: null },
    { name: "only a Task that runs", tasks: [taskOfSpan(1, "explain", "running", null)], expected: null },
    { name: "one finished Task", tasks: [taskOfSpan(1, "explain", "done", 40)], expected: 40_000 },
    { name: "the median of an odd number", tasks: [taskOfSpan(1, "explain", "done", 10), taskOfSpan(2, "explain", "done", 90), taskOfSpan(3, "explain", "done", 30)], expected: 30_000 },
    { name: "the middle of an even number", tasks: [taskOfSpan(1, "explain", "done", 20), taskOfSpan(2, "explain", "done", 40)], expected: 30_000 },
    { name: "the last five only", tasks: [taskOfSpan(1, "explain", "done", 1000), ...[2, 3, 4, 5, 6].map((seq) => taskOfSpan(seq, "explain", "done", 10))], expected: 10_000 },
  ])("takes $name", ({ tasks, expected }) => {
    expect(expectedDuration("explain", tasks)).toBe(expected);
  });

  it.each([
    { name: "a guess for the type without history", type: "explain" as const, tasks: [], expected: "This usually takes about a minute." },
    { name: "a guess for a Design", type: "design" as const, tasks: [], expected: "This usually takes a few minutes." },
    { name: "the span of the last one like it once there is one", type: "explain" as const, tasks: [taskOfSpan(1, "explain", "done", 42)], expected: "The last one like it took 42 s." },
  ])("says $name", ({ type, tasks, expected }) => {
    expect(waitingHint(type, tasks, seconds)).toBe(expected);
  });
});

describe("finishedAnnouncement and resultHeading", () => {
  const base: Task = { id: "1", sessionId: "s", seq: 1, type: "explain", target: { name: "m", resourceGroup: "r", subscriptionId: "s", entity: "svc-c" }, instruction: "", status: "done", createdAt: "2026-11-11T14:00:00Z" };
  const explained: Task = { ...base, result: { kind: "explain", entity: "svc-c", state: "Unhealthy", summary: "The queue is past its threshold.", causes: [] } };
  const diffed = (changes: number): Task => ({
    ...base,
    type: "review",
    result: { kind: "diff", summary: "Add a queue.", changes: Array.from({ length: changes }, (_, index) => ({ id: `c${index}`, op: "add" as const, kind: "entity" as const, name: `e${index}`, after: {}, reason: "r" })), verification: [], findings: [] },
  });

  const withSummary = (summary: string): Task => ({ ...explained, result: { ...(explained.result as ExplainResult), summary } });

  it.each([
    { name: "an Explain by its answer", task: explained, label: "Service C", expected: "Answer ready. The queue is past its threshold." },
    { name: "an Explain whose summary has evidence", task: withSummary("Service C is Unhealthy because its queue is full. The queue holds 42 items."), label: null, expected: "Answer ready. Service C is Unhealthy because its queue is full." },
    { name: "an Explain with no summary, by the state", task: withSummary(""), label: "Service C", expected: "Answer ready. Service C is Unhealthy." },
    { name: "an Explain with no summary and no display name", task: withSummary(""), label: null, expected: "Answer ready. svc-c is Unhealthy." },
    { name: "a model check with changes", task: diffed(3), label: null, expected: "Model check ready. 3 proposed changes. Add a queue." },
    { name: "a model check with one change", task: diffed(1), label: null, expected: "Model check ready. 1 proposed change. Add a queue." },
    { name: "a model check with none", task: diffed(0), label: null, expected: "Model check ready. No changes proposed. Add a queue." },
    { name: "a failed question with its reason", task: { ...base, status: "failed" as const, error: { code: "timeout", message: "The agent did not answer." } }, label: null, expected: "The assistant could not finish. The agent did not answer." },
    { name: "a failed question without a reason", task: { ...base, status: "failed" as const }, label: null, expected: "The assistant could not finish. It stopped without an answer." },
    { name: "a question that finished without a result", task: base, label: null, expected: "Explanation ready." },
  ])("announces $name", ({ task, label, expected }) => {
    expect(finishedAnnouncement(task, label)).toBe(expected);
  });

  it.each([
    { name: "a question about a past moment by its answer", task: { ...explained, asOf: "2026-11-11T23:40:00Z" }, label: "Service C", expected: "Answer ready. The queue is past its threshold." },
    { name: "a question about a past moment with no summary, by the state it had then", task: { ...withSummary(""), asOf: "2026-11-11T23:40:00Z" }, label: "Service C", expected: `Answer ready. Service C was Unhealthy at ${askedMoment({ asOf: "2026-11-11T23:40:00Z" })}.` },
  ])("announces $name", ({ task, label, expected }) => {
    expect(finishedAnnouncement(task, label)).toBe(expected);
    expect(resultHeading(task, label)).toBe(expected.replace("Answer ready. ", ""));
  });

  it.each([
    { name: "now", at: null, expected: "Service C is Unhealthy." },
    { name: "a past moment", at: "11 Nov 23:40", expected: "Service C was Unhealthy at 11 Nov 23:40." },
  ])("says the state an explanation found for $name", ({ at, expected }) => {
    expect(stateSentence("Service C", "Unhealthy", at)).toBe(expected);
  });

  it.each([
    { name: "an Explain by its answer", task: explained, label: "Service C", expected: "The queue is past its threshold." },
    { name: "an Explain whose summary has evidence", task: withSummary("Service C is Unhealthy. More."), label: null, expected: "Service C is Unhealthy." },
    { name: "an Explain with no summary", task: withSummary(""), label: "Service C", expected: "Service C is Unhealthy." },
    { name: "proposed changes", task: diffed(2), label: null, expected: "2 proposed changes" },
    { name: "no proposed changes", task: diffed(0), label: null, expected: "No changes proposed" },
    { name: "a Task without a result", task: base, label: null, expected: "Result" },
  ])("heads $name", ({ task, label, expected }) => {
    expect(resultHeading(task, label)).toBe(expected);
  });
});

describe("taskTitle", () => {
  const target = { name: "hm-demo", resourceGroup: "rg-app", subscriptionId: "sub-1" };
  it.each([
    { name: "an Explain of an Unhealthy entity", task: { type: "explain" as const, target: { ...target, entity: "svc-a" } }, label: "Service A", state: "Unhealthy" as const, expected: "Why is Service A Unhealthy?" },
    { name: "an Explain of a Healthy entity", task: { type: "explain" as const, target: { ...target, entity: "svc-a" } }, label: "Service A", state: "Healthy" as const, expected: "Why is Service A Healthy?" },
    { name: "an Explain of an Unknown entity", task: { type: "explain" as const, target: { ...target, entity: "svc-a" } }, label: "Service A", state: "Unknown" as const, expected: "Why is the state of Service A unknown?" },
    { name: "an Explain whose state is not known", task: { type: "explain" as const, target: { ...target, entity: "svc-a" } }, label: "Service A", state: null, expected: "Why is Service A in this state?" },
    { name: "an Explain without a display name", task: { type: "explain" as const, target: { ...target, entity: "svc-a" } }, label: null, state: null, expected: "Why is svc-a in this state?" },
    { name: "a model check", task: { type: "review" as const, target }, label: null, state: null, expected: "Check hm-demo" },
    { name: "a Design by the resource group", task: { type: "design" as const, target, workload: { resourceGroup: "rg-app" } }, label: null, state: null, expected: "Design for rg-app" },
    { name: "a Design by the repository", task: { type: "design" as const, target, workload: { resourceGroup: "rg-app", repositoryUrl: "https://github.com/octo/repo.git" } }, label: null, state: null, expected: "Design for octo/repo" },
  ])("titles $name", ({ task, label, state, expected }) => {
    expect(taskTitle(task, label, state)).toBe(expected);
  });

  const past = { type: "explain" as const, target: { ...target, entity: "svc-a" }, asOf: "2026-11-11T23:40:00Z" };
  it.each([
    { name: "an Unhealthy entity", task: past, label: "Service A", state: "Unhealthy" as const, zone: "UTC", expected: "Why was Service A Unhealthy at 11 Nov 23:40?" },
    { name: "an entity whose state is not known", task: past, label: "Service A", state: null, zone: "UTC", expected: "Why was Service A in this state at 11 Nov 23:40?" },
    { name: "an Unknown entity", task: past, label: null, state: "Unknown" as const, zone: "UTC", expected: "Why was the state of svc-a unknown at 11 Nov 23:40?" },
    { name: "the viewer's own day and clock", task: past, label: "Service A", state: "Degraded" as const, zone: "Europe/Zurich", expected: "Why was Service A Degraded at 12 Nov 00:40?" },
    { name: "a moment that is no time, as a question about now", task: { ...past, asOf: "then" }, label: "Service A", state: "Healthy" as const, zone: "UTC", expected: "Why is Service A Healthy?" },
    { name: "a model check, which is never about a moment", task: { type: "review" as const, target, asOf: "2026-11-11T23:40:00Z" }, label: null, state: null, zone: "UTC", expected: "Check hm-demo" },
  ])("titles a question about a past moment of $name with the moment", ({ task, label, state, zone, expected }) => {
    expect(taskTitle(task, label, state, zone)).toBe(expected);
  });

  it.each([
    { name: "a past moment with its day", asOf: "2026-11-11T23:40:00Z", expected: "11 Nov 23:40" },
    { name: "no moment", asOf: undefined, expected: null },
    { name: "a moment that is no time", asOf: "then", expected: null },
  ])("says $name", ({ asOf, expected }) => {
    expect(askedMoment(asOf === undefined ? {} : { asOf }, "UTC")).toBe(expected);
  });
});
