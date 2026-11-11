import { describe, expect, it } from "vitest";
import {
  buildTaskInput,
  designModelOf,
  hasRunningTask,
  instructionProblem,
  NO_DESIGN_MODEL,
  repositoryProblem,
  targetLabel,
  taskLabel,
  type TaskContext,
  type TaskDraft,
} from "./tasks";
import type { ModelCatalog, ModelRef, TaskSummary } from "./types";

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
    { url: `https://github.com/octo/${"r".repeat(200 - "https://github.com/octo/".length)}`, valid: true },
    { url: `https://github.com/octo/${"r".repeat(201 - "https://github.com/octo/".length)}`, valid: false },
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
    { name: "an explain without an entity", draft: draft({ type: "explain" }), context: { ...CONTEXT, entity: null }, problem: "Select an entity in the graph to explain it." },
    { name: "a review without a model", draft: draft({}), context: { ...CONTEXT, selected: null }, problem: "Choose a health model first." },
    { name: "a design without a design model", draft: draft({ type: "design" }), context: { ...CONTEXT, catalog: { ...CATALOG, models: [APP] } }, problem: NO_DESIGN_MODEL },
    { name: "a design without a catalog", draft: draft({ type: "design" }), context: { ...CONTEXT, catalog: null }, problem: "The health models are not loaded yet." },
    { name: "a bad repository", draft: draft({ type: "design", repositoryUrl: "nope" }), context: CONTEXT, problem: "Enter a public repository as https://github.com/owner/repository." },
    { name: "a long instruction", draft: draft({ instruction: "x".repeat(2001) }), context: CONTEXT, problem: "Keep the Task instruction to 2000 characters." },
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
    ["review", "Review"],
    ["explain", "Explain"],
    ["design", "Design"],
  ] as const)("labels %s as %s", (type, label) => {
    expect(taskLabel(type)).toBe(label);
  });

  it.each([
    { target: APP, expected: "hm-demo (rg-app)" },
    { target: { ...APP, entity: "svc-a" }, expected: "hm-demo (rg-app), entity svc-a" },
  ])("labels a target as $expected", ({ target, expected }) => {
    expect(targetLabel(target)).toBe(expected);
  });
});
