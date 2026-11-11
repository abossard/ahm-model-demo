import type {
  ModelCatalog,
  ModelRef,
  ModelSelection,
  TaskInput,
  TaskStatus,
  TaskSummary,
  TaskType,
} from "./types";

export interface TaskTypeInfo {
  readonly type: TaskType;
  readonly label: string;
  readonly description: string;
}

export const TASK_TYPES: readonly TaskTypeInfo[] = [
  { type: "review", label: "Review", description: "Inspect this health model and propose a Health model diff." },
  { type: "explain", label: "Explain", description: "Trace why an entity has its current health state." },
  { type: "design", label: "Design", description: "Derive a new health model for a Workload as a Health model diff." },
];

export const INSTRUCTION_MAX = 2000;
const REPOSITORY_URL_MAX = 200;

export const NO_DESIGN_MODEL = "This deployment has no design model, so Design is unavailable.";

const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?\/?$/;

export interface TaskDraft {
  readonly type: TaskType;
  readonly instruction: string;
  readonly repositoryUrl: string;
}

export interface TaskContext {
  /** The model on screen. */
  readonly selected: ModelSelection | null;
  /** The entity selected in the graph. */
  readonly entity: string | null;
  readonly catalog: ModelCatalog | null;
}

export function repositoryProblem(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  return GITHUB_REPOSITORY.test(trimmed) && trimmed.length <= REPOSITORY_URL_MAX
    ? null
    : "Enter a public repository as https://github.com/owner/repository.";
}

export function instructionProblem(text: string): string | null {
  return text.length > INSTRUCTION_MAX ? `Keep the Task instruction to ${INSTRUCTION_MAX} characters.` : null;
}

/** This deployment's design model: the default model's name with the `-design` suffix. */
export function designModelOf(catalog: ModelCatalog | null): ModelRef | null {
  if (!catalog) return null;
  const wanted = `${catalog.default.name}-design`;
  return (
    catalog.models.find(
      (model) =>
        model.name === wanted &&
        model.resourceGroup === catalog.default.resourceGroup &&
        model.subscriptionId === catalog.default.subscriptionId,
    ) ?? null
  );
}

export function selection(model: ModelSelection): ModelSelection {
  return { name: model.name, resourceGroup: model.resourceGroup, subscriptionId: model.subscriptionId };
}

export type TaskProblem = { readonly input: null; readonly problem: string };
export type TaskReady = { readonly input: TaskInput; readonly problem: null };

/** The request a draft makes in the current context, or why it cannot be sent yet. */
export function buildTaskInput(draft: TaskDraft, context: TaskContext): TaskReady | TaskProblem {
  const instruction = draft.instruction.trim();
  const invalid = instructionProblem(draft.instruction);
  if (invalid) return { input: null, problem: invalid };
  if (draft.type === "design") {
    const repository = repositoryProblem(draft.repositoryUrl);
    if (repository) return { input: null, problem: repository };
    const catalog = context.catalog;
    if (!catalog) return { input: null, problem: "The health models are not loaded yet." };
    // The app designs against its design model whatever the request names, so there is no other target to send.
    const design = designModelOf(catalog);
    if (!design) return { input: null, problem: NO_DESIGN_MODEL };
    const url = draft.repositoryUrl.trim();
    return {
      problem: null,
      input: {
        type: "design",
        target: selection(design),
        workload: { resourceGroup: catalog.default.resourceGroup, ...(url ? { repositoryUrl: url } : {}) },
        instruction,
      },
    };
  }
  if (!context.selected) return { input: null, problem: "Choose a health model first." };
  if (draft.type === "explain") {
    if (!context.entity) return { input: null, problem: "Select an entity in the graph to explain it." };
    return {
      problem: null,
      input: { type: "explain", target: { ...selection(context.selected), entity: context.entity }, instruction },
    };
  }
  return { problem: null, input: { type: "review", target: selection(context.selected), instruction } };
}

export function isUnfinished(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function hasRunningTask(tasks: readonly TaskSummary[]): boolean {
  return tasks.some((task) => isUnfinished(task.status));
}

export function taskLabel(type: TaskType): string {
  return TASK_TYPES.find((item) => item.type === type)?.label ?? type;
}

export function targetLabel(target: ModelSelection & { readonly entity?: string }): string {
  const model = `${target.name} (${target.resourceGroup})`;
  return target.entity ? `${model}, entity ${target.entity}` : model;
}
