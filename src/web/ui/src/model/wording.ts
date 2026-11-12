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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The question the user has about an entity in the state it is in: what the Explain button says. The state names are
 * Azure's, so they keep their capital; an Unknown state is asked about as a state, as nothing "is Unknown" in plain speech.
 * With `at`, a past moment as `momentWords` says it, the question is about the state it had then, in the past tense.
 */
export function whyQuestion(state: HealthState | null, subject: string | null = null, at: string | null = null): string {
  const who = subject ?? "this";
  const is = at === null ? "is" : "was";
  const when = at === null ? "" : ` at ${at}`;
  switch (state) {
    case "Healthy":
    case "Degraded":
    case "Unhealthy":
      return `Why ${is} ${who} ${state}${when}?`;
    case "Unknown":
      return subject === null ? `Why ${is} the state unknown${when}?` : `Why ${is} the state of ${subject} unknown${when}?`;
    case "Deleted":
      return at === null ? `What happened to ${who}?` : `What happened to ${who} before ${at}?`;
    case null:
      return subject === null ? `Why ${is} it in this state${when}?` : `Why ${is} ${subject} in this state${when}?`;
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

/**
 * A past moment in a sentence: the clock alone on the day of `now` ("23:40"), the day with it on any other
 * ("11 Nov 23:40"). Without a `now`, as in a title that is read on later days, it always names the day.
 */
export function momentWords(at: number, now: number | null, timeZone?: string): string {
  const full = formatSessionTime(new Date(at), timeZone);
  const dayOf = (text: string): string => text.slice(0, text.lastIndexOf(" "));
  if (now === null || dayOf(formatSessionTime(new Date(now), timeZone)) !== dayOf(full)) return full;
  return full.slice(full.lastIndexOf(" ") + 1);
}

/** How long ago something was, as far as it matters: "under a minute ago", "12 min ago", "2 h 10 min ago", "3 days 4 h ago". */
export function agoWords(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / MINUTE);
  if (minutes < 1) return "under a minute ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`} ago`;
  return `${plural(Math.floor(hours / 24), "day")}${hours % 24 === 0 ? "" : ` ${hours % 24} h`} ago`;
}

/** What the page says while it shows a past moment: "Showing 11 Nov 23:40:00, 2 h 10 min ago". */
export function showingMoment(at: number, now: number, timeZone?: string): string {
  return `Showing ${formatUpdated(new Date(at).toISOString(), timeZone)}, ${agoWords(now - at)}`;
}

/** What a model check and a design say while the page shows a past moment: they are about the model now. */
export const ABOUT_NOW = "as it is now";
export const NOW_NOTE = "The page shows a past moment. This looks at the model as it is now.";

/** What the answer to a question about a past moment says of the state it found: "State at 11 Nov 23:40". */
export function stateHeading(at: string | null): string {
  return at === null ? "Current state" : `State at ${at}`;
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
