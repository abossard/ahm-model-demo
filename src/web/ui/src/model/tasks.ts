import { splitAnswer } from "./agentText";
import { TASK_KIND, momentWords, proposedCount, whyQuestion } from "./wording";
import type {
  HealthState,
  ModelCatalog,
  ModelRef,
  ModelSelection,
  Task,
  TaskInput,
  TaskStatus,
  TaskSummary,
  TaskType,
} from "./types";

export interface TaskTypeInfo {
  readonly type: TaskType;
  /** The tab of the form: what the user wants to find out or get. */
  readonly label: string;
  /** The button that sends the form. */
  readonly submit: string;
  readonly description: string;
}

export const TASK_TYPES: readonly TaskTypeInfo[] = [
  { type: "explain", label: "Why this state?", submit: "Ask why", description: "Finds out why an entity has its current health state, step by step." },
  { type: "review", label: "Check this model", submit: "Check model", description: "Looks for gaps and risks in this health model and proposes changes you can apply." },
  { type: "design", label: "Design a model", submit: "Design model", description: "Proposes a new health model for your workload, as changes you can review and apply." },
];

export const INSTRUCTION_MAX = 2000;

export const NO_DESIGN_MODEL = "There is no separate model to save a design in, so designing is not available here.";

// The rule of the web app (config.py) and the agent (clone.py): keep the three the same.
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\.git)?\/?$/;

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
  /** The past moment the page shows, null or absent for now: an Explain asks about it, a Review and a Design never do. */
  readonly moment?: number | null;
}

export function repositoryProblem(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  return GITHUB_REPOSITORY.test(trimmed)
    ? null
    : "Enter a public GitHub repository, such as https://github.com/owner/repository.";
}

export function instructionProblem(text: string): string | null {
  return text.length > INSTRUCTION_MAX ? `Keep the note to ${INSTRUCTION_MAX} characters.` : null;
}

/** This deployment's design model: the default model's name with the `-design` suffix. */
export function designModelOf(catalog: ModelCatalog | null): ModelRef | null {
  const base = catalog?.default;
  if (!catalog || !base) return null;
  const wanted = `${base.name}-design`;
  return (
    catalog.models.find(
      (model) => model.name === wanted && model.resourceGroup === base.resourceGroup && model.subscriptionId === base.subscriptionId,
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
    if (!catalog) return { input: null, problem: "The health models are still loading." };
    // The app designs against its design model whatever the request names, so there is no other target to send.
    const design = designModelOf(catalog);
    if (!design) return { input: null, problem: NO_DESIGN_MODEL };
    const url = draft.repositoryUrl.trim();
    return {
      problem: null,
      input: {
        type: "design",
        target: selection(design),
        workload: { resourceGroup: design.resourceGroup, ...(url ? { repositoryUrl: url } : {}) },
        instruction,
      },
    };
  }
  if (!context.selected) return { input: null, problem: "Choose a health model first." };
  if (draft.type === "explain") {
    if (!context.entity) return { input: null, problem: "Select an entity in the graph first." };
    const asOf = context.moment === null || context.moment === undefined ? {} : { asOf: new Date(context.moment).toISOString() };
    return {
      problem: null,
      input: { type: "explain", target: { ...selection(context.selected), entity: context.entity }, instruction, ...asOf },
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

/** What a kind of Task is called in a sentence: "Explanation", "Model check", "Design". */
export function taskLabel(type: TaskType): string {
  return TASK_KIND[type];
}

/** The model a Task ran on, as Azure names it. */
export function targetLabel(target: ModelSelection): string {
  return `${target.name} (${target.resourceGroup})`;
}

function repositoryName(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "").replace(/\.git$/, "");
}

/** The past moment a Task is about, as its title and its answer say it: always with its day, as both are read on later days. */
export function askedMoment(task: Pick<TaskInput, "asOf">, timeZone?: string): string | null {
  const at = task.asOf === undefined ? Number.NaN : Date.parse(task.asOf);
  return Number.isNaN(at) ? null : momentWords(at, null, timeZone);
}

/**
 * What a Task is about, as the user would say it: the question an Explain answers, or what a Review or Design is for.
 * The state is the one the entity had when it was asked about; without it the question names no state. An Explain about
 * a past moment names the moment.
 */
export function taskTitle(
  task: Pick<TaskInput, "type" | "target" | "workload" | "asOf">,
  entityLabel: string | null,
  state: HealthState | null,
  timeZone?: string,
): string {
  if (task.type === "explain") return whyQuestion(state, entityLabel ?? task.target.entity ?? "an entity", askedMoment(task, timeZone));
  if (task.type === "design") {
    const repository = task.workload?.repositoryUrl;
    return `Design for ${repository ? repositoryName(repository) : (task.workload?.resourceGroup ?? task.target.name)}`;
  }
  return `Check ${task.target.name}`;
}

/** The request that starts the same Task again: what a failed Task asked for, not what is on screen now. */
export function inputOfTask(task: Pick<Task, "type" | "target" | "workload" | "instruction" | "asOf">): TaskInput {
  return {
    type: task.type,
    target: task.target,
    ...(task.workload ? { workload: task.workload } : {}),
    instruction: task.instruction,
    ...(task.asOf ? { asOf: task.asOf } : {}),
  };
}

const TYPICAL: Readonly<Record<TaskType, string>> = {
  explain: "about a minute",
  review: "a few minutes",
  design: "a few minutes",
};
const SAMPLE = 5;

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/**
 * How long a Task of this type usually takes, in milliseconds, from the finished ones of the Session; null without any.
 * Failed Tasks say nothing about how long a good run takes.
 */
export function expectedDuration(type: TaskType, tasks: readonly TaskSummary[]): number | null {
  const spans = tasks
    .filter((task) => task.type === type && task.status === "done" && task.finishedAt !== undefined)
    .slice(-SAMPLE)
    .map((task) => Date.parse(task.finishedAt!) - Date.parse(task.createdAt))
    .filter((span) => Number.isFinite(span) && span >= 0);
  return spans.length === 0 ? null : median(spans);
}

/** What to tell a user who waits: the span earlier questions of the Session took, or a rough guess for the type. */
export function waitingHint(type: TaskType, tasks: readonly TaskSummary[], format: (milliseconds: number) => string): string {
  const span = expectedDuration(type, tasks);
  return span === null ? `This usually takes ${TYPICAL[type]}.` : `The last one like it took ${format(span)}.`;
}

/** What an explanation found, in one sentence: "Service C is Unhealthy.", or for a past moment "Service C was Unhealthy at 11 Nov 23:40." */
export function stateSentence(subject: string, state: HealthState, at: string | null): string {
  return at === null ? `${subject} is ${state}.` : `${subject} was ${state} at ${at}.`;
}

/** The answer sentence of an explanation: the first sentence of the summary, or the state when the summary is empty. */
function answerOf(result: { readonly summary: string; readonly entity: string; readonly state: HealthState }, entityLabel: string | null, at: string | null): string {
  const { answer } = splitAnswer(result.summary);
  return answer !== "" ? answer : stateSentence(entityLabel ?? result.entity, result.state, at);
}

/** What a screen reader hears when a Task ends: that it did, and the one thing the user came for. */
export function finishedAnnouncement(task: Task, entityLabel?: string | null): string {
  const kind = taskLabel(task.type);
  if (task.status === "failed") return `The assistant could not finish. ${task.error?.message ?? "It stopped without an answer."}`;
  const result = task.result;
  if (result?.kind === "explain") return `Answer ready. ${answerOf(result, entityLabel ?? null, askedMoment(task))}`;
  if (result?.kind === "diff") return `${kind} ready. ${proposedCount(result.changes.length)}. ${splitAnswer(result.summary).answer}`;
  return `${kind} ready.`;
}

/** The heading of a Task's result, which takes focus when the result opens by itself: for an Explain, the answer itself. */
export function resultHeading(task: Pick<Task, "type" | "result" | "asOf">, entityLabel?: string | null): string {
  const result = task.result;
  if (result?.kind === "explain") return answerOf(result, entityLabel ?? null, askedMoment(task));
  if (result?.kind === "diff") return proposedCount(result.changes.length);
  return "Result";
}
