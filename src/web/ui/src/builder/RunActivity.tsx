import { useMemo } from "react";
import { ActivityList } from "../components/ActivityList";
import { pairToolEvents, presentActivity } from "../model/activity";
import { formatDuration, taskDuration } from "../model/duration";
import { isRunning, type BuilderTask } from "./types";

const tokenCounts = [
  ["inputTokens", "Input"], ["cachedInputTokens", "Cached input"],
  ["outputTokens", "Output"], ["reasoningTokens", "Reasoning"],
] as const;

export function RunActivity({ task, label }: { task: BuilderTask<unknown>; label: string }) {
  const { activity, usage } = task;
  const running = isRunning(task);
  const events = useMemo(() => pairToolEvents(activity ?? [], !running), [activity, running]);
  const counts = tokenCounts.flatMap(([key, title]) => {
    const count = usage?.[key];
    return count === undefined ? [] : [{title, count}];
  });
  const hasUsage = Boolean(counts.length) || usage?.totalTokens !== undefined;
  if (!activity?.length && !hasUsage) return null;
  const calls = activity?.filter(event => event.kind === "tool_call").length ?? 0;
  const duration = task.createdAt && task.finishedAt
    ? taskDuration({ createdAt: task.createdAt, finishedAt: task.finishedAt }, 0) : null;
  const info = [
    `${calls} tool ${calls === 1 ? "call" : "calls"}`,
    duration === null ? null : formatDuration(duration),
    usage?.totalTokens === undefined ? null : `${usage.totalTokens.toLocaleString()} tokens`,
  ].filter(Boolean).join(" · ");
  const latest = activity?.at(-1);
  return (
    <details className="run-activity">
      <summary>
        <span className="run-activity-summary"><strong>{label}</strong><small>{info}</small></span>
        {running && latest && <span className="run-activity-latest" role="status">{presentActivity(latest).title}</span>}
      </summary>
      <div className="run-activity-content">
        <ActivityList events={events} emptyMessage="No steps were recorded." />
        {counts.length > 0 && <dl className="run-token-counts" aria-label="Reported token usage">
          {counts.map(({title, count}) => <div key={title}><dt>{title}</dt><dd>{count.toLocaleString()}</dd></div>)}
        </dl>}
        {!hasUsage && !running && <small>Token usage was unavailable for this run.</small>}
      </div>
    </details>
  );
}
