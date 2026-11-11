import type { Confidence, HealthState, ResultWindow, TaskStatus, TaskType } from "./types";

/**
 * What the interface calls things. In code, the API and the docs the words are the domain's own (Task, Session,
 * Activity timeline, Health model diff); on screen the user's question or goal leads. The names Azure gives
 * (entity, signal, health model, Healthy, Degraded, Unhealthy, Unknown, Limited, Suppressed) stay as they are,
 * because the user meets the same words in the portal. See GLOSSARY.md for the table.
 */
export const WORDS = {
  /** The Tasks of a Session. */
  questions: "Questions",
  /** The Activity timeline, once the assistant is done, and while it works. */
  stepsDone: "What the assistant did",
  stepsRunning: "What the assistant is doing",
  /** The Health model diff. */
  proposed: "Proposed changes",
} as const;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The question the user has about an entity in the state it is in: what the Explain button says. The state names are
 * Azure's, so they keep their capital; an Unknown state is asked about as a state, as nothing "is Unknown" in plain speech.
 */
export function whyQuestion(state: HealthState | null, subject: string | null = null): string {
  const who = subject ?? "this";
  switch (state) {
    case "Healthy":
    case "Degraded":
    case "Unhealthy":
      return `Why is ${who} ${state}?`;
    case "Unknown":
      return subject === null ? "Why is the state unknown?" : `Why is the state of ${subject} unknown?`;
    case "Deleted":
      return `What happened to ${who}?`;
    case null:
      return subject === null ? "Why is it in this state?" : `Why is ${subject} in this state?`;
  }
}

/** What a kind of Task is called in a sentence: "Explanation ready", "Model check failed". */
export const TASK_KIND: Readonly<Record<TaskType, string>> = {
  explain: "Explanation",
  review: "Model check",
  design: "Design",
};

/** The Task status as the user reads it. */
export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  queued: "Waiting",
  running: "Working",
  done: "Done",
  failed: "Did not finish",
};

/** When the model was last read, as a person writes it: "30 Jul, 16:05:00". The seconds tell two refreshes apart. */
export function formatUpdated(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  })
    .format(date)
    .replace(",", "");
}

/** "3 proposed changes", "No changes proposed". */
export function proposedCount(count: number): string {
  return count === 0 ? "No changes proposed" : `${plural(count, "proposed change")}`;
}

/** The day and the minute, which is all that tells two Sessions of one day apart: "11 Nov 14:05". */
export function formatSessionTime(when: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(when);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
}


/** What the user is told of how sure the assistant is: the word, and what it means for what they do next. */
export function howSure(confidence: Confidence): { readonly label: string; readonly hint: string } {
  switch (confidence) {
    case "high":
      return { label: "High", hint: "The assistant found clear evidence for this." };
    case "medium":
      return { label: "Medium", hint: "The assistant found some evidence, but not all of it. Check the steps before you rely on it." };
    case "low":
      return { label: "Low", hint: "The assistant found little evidence. Treat this as a first guess." };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The time an explanation looked at, as a person says it: "the last 3 hours (until 11 Nov 14:05)". Null when the window is not dates. */
export function lookedAt(window: ResultWindow, timeZone?: string): string | null {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  const span = to - from;
  const length =
    span < 90 * MINUTE
      ? plural(Math.max(1, Math.round(span / MINUTE)), "minute")
      : span < 36 * HOUR
        ? plural(Math.round(span / HOUR), "hour")
        : plural(Math.round(span / DAY), "day");
  return `the last ${length} (until ${formatSessionTime(new Date(to), timeZone)})`;
}
