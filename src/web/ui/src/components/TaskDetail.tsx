import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  SkeletonItem,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { formatDuration, taskDuration } from "../model/duration";
import { taskFailure } from "../model/errors";
import { isUnfinished, targetLabel, taskLabel } from "../model/tasks";
import type { Task } from "../model/types";
import { actions, useStore } from "../store/store";
import { ActivityTimeline } from "./ActivityTimeline";
import { DiffResult } from "./DiffResult";
import { ExplainResult } from "./ExplainResult";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { TimelineAnnouncer } from "./TimelineAnnouncer";
import { useNow } from "./useNow";

type Pane = "result" | "timeline";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, flex: 1, minHeight: 0 },
  // What sits above the pane keeps its height, so the pane is the only part that scrolls or shrinks.
  top: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridAutoRows: "max-content", rowGap: tokens.spacingVerticalS, flex: "0 0 auto" },
  fixed: { flexShrink: 0 },
  head: { display: "flex", flexDirection: "column", rowGap: "2px", flexShrink: 0 },
  titleRow: { display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: tokens.spacingHorizontalS },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, overflowWrap: "anywhere" },
  instruction: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    display: "-webkit-box",
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    overflowWrap: "anywhere",
  },
  pane: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflowY: "auto", rowGap: tokens.spacingVerticalS },
  waiting: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
});

function Header({ task }: { readonly task: Task }): JSX.Element {
  const styles = useStyles();
  const running = isUnfinished(task.status);
  const now = useNow(running);
  const elapsed = taskDuration(task, now);
  return (
    <div className={styles.head} data-testid="task-header">
      <div className={styles.titleRow}>
        <Text as="h3" size={400} weight="semibold" data-testid="task-title">
          {taskLabel(task.type)} #{task.seq}
        </Text>
        <TaskStatusBadge status={task.status} />
        {elapsed !== null ? (
          <Text className={styles.meta} data-testid="task-duration">
            {formatDuration(elapsed)}
          </Text>
        ) : null}
      </div>
      <Text className={styles.meta} data-testid="task-target">
        {targetLabel(task.target)}
        {task.workload?.repositoryUrl ? `, repository ${task.workload.repositoryUrl}` : ""}
      </Text>
      {task.instruction !== "" ? (
        <Text className={styles.instruction} title={task.instruction} data-testid="task-instruction">
          Task instruction: {task.instruction}
        </Text>
      ) : null}
    </div>
  );
}

function Result({ task }: { readonly task: Task }): JSX.Element {
  const styles = useStyles();
  const result = task.result;
  if (result?.kind === "explain") return <ExplainResult task={task} result={result} />;
  if (result?.kind === "diff") return <DiffResult task={task} />;
  return (
    <Text as="p" className={styles.waiting} data-testid="task-no-result">
      This Task finished without a result.
    </Text>
  );
}

function TaskBody({ task }: { readonly task: Task }): JSX.Element {
  const styles = useStyles();
  const eventCount = useStore((state) => state.events.length);
  const hasResult = task.status === "done";
  const [pane, setPane] = useState<Pane>(hasResult ? "result" : "timeline");
  // The result is ready but the reader is still on an earlier step of the timeline.
  const [waiting, setWaiting] = useState(false);
  const previous = useRef(task.status);
  const reading = useRef(false);

  // The result is what the user waits for, so it opens by itself when the Task finishes,
  // unless they scrolled back to read an earlier step: they are told and choose.
  useEffect(() => {
    if (previous.current !== task.status && task.status === "done") {
      if (reading.current) setWaiting(true);
      else setPane("result");
    }
    previous.current = task.status;
  }, [task.status]);

  const showPane = (next: Pane): void => {
    setPane(next);
    if (next === "result") setWaiting(false);
  };

  const shown: Pane = hasResult ? pane : "timeline";
  const failure = taskFailure(task.error);

  return (
    <>
      <div className={styles.top}>
        {task.status === "failed" ? (
          <MessageBar intent="error" role="alert" data-testid="task-failed" data-code={task.error?.code}>
            <MessageBarBody>
              <MessageBarTitle>{failure.title}</MessageBarTitle>
              {failure.message}
            </MessageBarBody>
            <MessageBarActions>
              <Button
                size="small"
                onClick={() => {
                  actions.updateDraft({ type: task.type, instruction: task.instruction });
                  actions.prefillTask(task.type);
                  void actions.openTask(null);
                }}
                data-testid="task-retry"
              >
                Start again
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}
        {hasResult ? (
          <TabList
            size="small"
            selectedValue={shown}
            onTabSelect={(_, data) => showPane(data.value as Pane)}
            aria-label="Task view"
          >
            <Tab value="result" data-testid="task-tab-result">
              Result
            </Tab>
            <Tab value="timeline" data-testid="task-tab-timeline">
              Activity timeline ({eventCount})
            </Tab>
          </TabList>
        ) : null}
        {task.status === "running" || task.status === "queued" ? (
          <Text className={styles.waiting} data-testid="task-waiting">
            The result appears here when the Task finishes.
          </Text>
        ) : null}
        {waiting && shown === "timeline" ? (
          <MessageBar intent="success" data-testid="task-result-ready">
            <MessageBarBody>The Task finished. Its result is ready.</MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={() => showPane("result")} data-testid="task-show-result">
                Show result
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}
      </div>
      <TimelineAnnouncer />
      <div className={styles.pane} role={hasResult ? "tabpanel" : undefined} aria-label={hasResult ? (shown === "result" ? "Result" : "Activity timeline") : undefined}>
        {shown === "result" ? (
          <Result task={task} />
        ) : (
          <ActivityTimeline
            onReading={(value) => {
              reading.current = value;
            }}
          />
        )}
      </div>
    </>
  );
}

export function TaskDetail(): JSX.Element {
  const styles = useStyles();
  const task = useStore((state) => state.task);
  const taskSeq = useStore((state) => state.taskSeq);

  return (
    <section className={styles.root} aria-label="Task" data-testid="task-detail">
      {task.kind === "loading" || task.kind === "idle" ? (
        <div className={styles.fixed} data-testid="task-loading" aria-busy="true" aria-label="Loading the Task">
          <SkeletonItem size={28} />
        </div>
      ) : null}
      {task.kind === "failure" ? (
        <MessageBar intent="error" role="alert" className={styles.fixed} data-testid="task-error">
          <MessageBarBody>{task.error.message}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void actions.openTask(taskSeq)}>
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}
      {task.kind === "success" ? (
        <>
          <Header task={task.value} />
          <TaskBody task={task.value} />
        </>
      ) : null}
    </section>
  );
}
