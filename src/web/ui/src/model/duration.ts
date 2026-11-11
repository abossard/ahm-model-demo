import type { TaskSummary } from "./types";

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 1) return "under 1 s";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** How long a Task ran, or has been running so far; null when its start is not a date. */
export function taskDuration(task: Pick<TaskSummary, "createdAt" | "finishedAt">, now: number): number | null {
  const started = Date.parse(task.createdAt);
  if (Number.isNaN(started)) return null;
  const ended = task.finishedAt === undefined ? now : Date.parse(task.finishedAt);
  return Number.isNaN(ended) ? null : Math.max(0, ended - started);
}

export function formatOffset(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A date and time for a list row, or the text itself when it is not a date. */
export function formatWhen(value: string | null, timeZone?: string): string {
  if (value === null) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
}
