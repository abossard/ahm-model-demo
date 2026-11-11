import type { SessionSummary } from "./types";

function lastActivity(session: SessionSummary): number {
  const time = Date.parse(session.lastTaskAt ?? session.createdAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** The Sessions with the most recent activity first; Sessions with the same time keep the order they came in. */
export function orderSessions(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
  return [...sessions].sort((left, right) => lastActivity(right) - lastActivity(left));
}
