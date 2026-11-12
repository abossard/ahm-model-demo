import { isUnfinished, taskTitle } from "./tasks";
import { formatSessionTime } from "./wording";

export { formatSessionTime };
import type { HealthState, SessionSummary, TaskInput, TaskSummary } from "./types";

function lastActivity(session: SessionSummary): number {
  const time = Date.parse(session.lastTaskAt ?? session.createdAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** The Sessions with the most recent activity first; Sessions with the same time keep the order they came in. */
export function orderSessions(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  return [...sessions].sort((left, right) => lastActivity(right) - lastActivity(left));
}

/** The app's Session title limit. */
export const SESSION_TITLE_MAX = 120;

/** A Task the user has running, in the Session it runs in. */
export interface RunningRef {
  readonly sessionId: string;
  readonly seq: number;
}

/** The app stops a Task after 10 minutes, so a Session quiet for longer cannot hold one that still runs. */
export const TASK_LIFETIME_MS = 11 * 60_000;
const SCANNED_SESSIONS = 5;

/** The title of a Session that a one-click Task creates: what was asked and the minute it was asked, within the app's limit. */
export function sessionTitle(
  input: TaskInput,
  entityLabel: string | null,
  state: HealthState | null,
  when: Date,
  timeZone?: string,
): string {
  const suffix = ` (${formatSessionTime(when, timeZone)})`;
  const subject = taskTitle(input, entityLabel, state, timeZone);
  const room = SESSION_TITLE_MAX - suffix.length;
  return `${subject.length <= room ? subject : `${subject.slice(0, room - 3)}...`}${suffix}`;
}

/** The Task of a Session that has not finished, if any. */
export function runningIn(tasks: readonly TaskSummary[]): TaskSummary | undefined {
  return tasks.find((task) => isUnfinished(task.status));
}

/** The Session a one-click Task is about to use, as far as the app has told us what is in it. */
export interface OpenSession {
  readonly id: string;
  /** Null while the Session's Tasks are not loaded. */
  readonly tasks: readonly TaskSummary[] | null;
}

export type StartPlan =
  | { readonly kind: "use"; readonly sessionId: string }
  | { readonly kind: "create" }
  | { readonly kind: "blocked"; readonly running: RunningRef };

/**
 * Where a one-click Task goes. The open Session takes it unless a Task of the user runs already (the app allows one),
 * and then nothing is created: the running Task is what the user is told about. Without an open Session a new one is made.
 */
export function planStart(open: OpenSession | null, elsewhere: RunningRef | null): StartPlan {
  const inOpen = open?.tasks ? runningIn(open.tasks) : undefined;
  if (open && inOpen) return { kind: "blocked", running: { sessionId: open.id, seq: inOpen.seq } };
  if (elsewhere) return { kind: "blocked", running: elsewhere };
  return open ? { kind: "use", sessionId: open.id } : { kind: "create" };
}

/** The Sessions worth asking for a running Task: the newest few that saw a Task within the time a Task can run. */
export function mayHoldRunningTask(sessions: readonly SessionSummary[], now: number): readonly SessionSummary[] {
  return orderSessions(sessions)
    .filter((session) => {
      const last = Date.parse(session.lastTaskAt ?? "");
      return session.taskCount > 0 && !Number.isNaN(last) && now - last <= TASK_LIFETIME_MS;
    })
    .slice(0, SCANNED_SESSIONS);
}
