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
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { formatDuration, taskDuration } from "../model/duration";
import { openFailure, taskFailure } from "../model/errors";
import { isUnfinished, resultHeading, targetLabel, taskTitle, waitingHint } from "../model/tasks";
import { WORDS } from "../model/wording";
import type { Task, TaskSummary } from "../model/types";
import { actions, useStore } from "../store/store";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentText } from "./AgentText";
import { DiffResult } from "./DiffResult";
import { ExplainResult } from "./ExplainResult";
import { focusFirst, focusIsFree } from "./focus";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { TechnicalLine } from "./TechnicalLine";
import { TimelineAnnouncer } from "./TimelineAnnouncer";
import { useEntityLabel } from "./useEntityLabel";
import { useNow } from "./useNow";

type Pane = "result" | "timeline";

const NO_TASKS: readonly TaskSummary[] = [];
const NO_PROBLEMS: readonly string[] = [];
const PROBLEMS_SHOWN = 5;

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
  title: { fontSize: tokens.fontSizeBase400, lineHeight: tokens.lineHeightBase400, fontWeight: tokens.fontWeightSemibold },
  heading: { margin: 0, ":focus-visible": { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: "2px" } },
  waiting: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  problemsLead: { display: "block", marginTop: tokens.spacingVerticalXS },
  problems: { margin: `${tokens.spacingVerticalXXS} 0 0`, paddingLeft: tokens.spacingHorizontalL, fontSize: tokens.fontSizeBase200 },
});

function Header({ task }: { readonly task: Task }): JSX.Element {
  const styles = useStyles();
  const running = isUnfinished(task.status);
  const now = useNow(running);
  const elapsed = taskDuration(task, now);
  const heading = useRef<HTMLHeadingElement>(null);
  const entityLabel = useEntityLabel(task.target.entity);
  // The question names the state the entity had when it was asked, which only the answer knows.
  const title = taskTitle(task, entityLabel, task.result?.kind === "explain" ? task.result.state : null);

  // A Task that opens in place of a list, a form or a button that is gone puts the reader at its name.
  useEffect(() => {
    if (focusIsFree()) heading.current?.focus();
  }, [task.seq]);

  return (
    <div className={styles.head} data-testid="task-header">
      <div className={styles.titleRow}>
        <h3 ref={heading} tabIndex={-1} className={mergeClasses(styles.heading, styles.title)} data-testid="task-title">
          {title}
        </h3>
        <TaskStatusBadge status={task.status} />
        {elapsed !== null ? (
          <Text className={styles.meta} data-testid="task-duration">
            {formatDuration(elapsed)}
          </Text>
        ) : null}
      </div>
      <Text className={styles.meta} data-testid="task-target">
        Model {targetLabel(task.target)}
        {task.workload?.repositoryUrl ? `, GitHub repository ${task.workload.repositoryUrl}` : ""}
      </Text>
      {task.instruction !== "" ? (
        <Text className={styles.instruction} title={task.instruction} data-testid="task-instruction">
          Your note: {task.instruction}
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
      The assistant finished without writing an answer.
    </Text>
  );
}

function TaskBody({ task }: { readonly task: Task }): JSX.Element {
  const styles = useStyles();
  const eventCount = useStore((state) => state.events.length);
  const tasks = useStore((state) => (state.sessionDetail.kind === "success" ? state.sessionDetail.value.tasks : NO_TASKS));
  const entityLabel = useEntityLabel(task.target.entity);
  const answerLabel = task.type === "explain" ? "Answer" : WORDS.proposed;
  const paneRef = useRef<HTMLDivElement>(null);
  // Set when the result opened by itself: the next render has its heading, and that is where the reader goes.
  const arrived = useRef(false);
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
      else {
        setPane("result");
        arrived.current = true;
      }
    }
    previous.current = task.status;
  }, [task.status]);

  const showPane = (next: Pane): void => {
    setPane(next);
    if (next === "result") setWaiting(false);
  };

  const shown: Pane = hasResult ? pane : "timeline";
  const failure = taskFailure(task.error);
  const problems = task.error?.problems ?? NO_PROBLEMS;

  useEffect(() => {
    if (shown !== "result" || !arrived.current) return;
    arrived.current = false;
    focusFirst(paneRef.current, "[data-result-heading]");
  }, [shown]);

  return (
    <>
      <div className={styles.top}>
        {task.status === "failed" ? (
          <MessageBar intent="error" role="alert" data-testid="task-failed" data-code={task.error?.code}>
            <MessageBarBody>
              <MessageBarTitle>{failure.title}</MessageBarTitle>
              {failure.message}
              {problems.length > 0 ? (
                <>
                  <span className={styles.problemsLead}>What was wrong with its last answer:</span>
                  <ul className={styles.problems} data-testid="task-problems">
                    {problems.slice(0, PROBLEMS_SHOWN).map((problem, index) => (
                      <li key={index}>
                        <AgentText text={problem} />
                      </li>
                    ))}
                    {problems.length > PROBLEMS_SHOWN ? <li>and {problems.length - PROBLEMS_SHOWN} more</li> : null}
                  </ul>
                </>
              ) : null}
              <TechnicalLine text={failure.technical} />
            </MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={() => void actions.rerunTask(task)} data-testid="task-retry">
                Try again
              </Button>
              <Button
                size="small"
                onClick={() => {
                  actions.updateDraft({ type: task.type, instruction: task.instruction });
                  actions.prefillTask(task.type);
                }}
                data-testid="task-edit"
              >
                Change my note
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}
        {hasResult ? (
          <TabList
            size="small"
            selectedValue={shown}
            onTabSelect={(_, data) => showPane(data.value as Pane)}
            aria-label="View"
          >
            <Tab value="result" data-testid="task-tab-result">
              {answerLabel}
            </Tab>
            <Tab value="timeline" data-testid="task-tab-timeline">
              {WORDS.stepsDone} ({eventCount})
            </Tab>
          </TabList>
        ) : null}
        {task.status === "running" || task.status === "queued" ? (
          <Text className={styles.waiting} data-testid="task-waiting">
            The {task.type === "explain" ? "answer" : "proposed changes"} open{task.type === "explain" ? "s" : ""} here when the assistant is done. {waitingHint(task.type, tasks, formatDuration)}
          </Text>
        ) : null}
        {waiting && shown === "timeline" ? (
          <MessageBar intent="success" data-testid="task-result-ready">
            <MessageBarBody>The assistant is done. {task.type === "explain" ? "The answer is" : "The proposed changes are"} ready.</MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={() => showPane("result")} data-testid="task-show-result">
                {task.type === "explain" ? "Show the answer" : "Show proposed changes"}
              </Button>
            </MessageBarActions>
          </MessageBar>
        ) : null}
      </div>
      <TimelineAnnouncer />
      <div ref={paneRef} className={styles.pane} role={hasResult ? "tabpanel" : undefined} aria-label={hasResult ? (shown === "result" ? answerLabel : WORDS.stepsDone) : undefined}>
        {shown === "result" ? (
          <>
            <Text as="h4" size={300} weight="semibold" tabIndex={-1} className={styles.heading} data-result-heading="" data-testid="result-heading">
              <AgentText text={resultHeading(task, entityLabel)} />
            </Text>
            <Result task={task} />
          </>
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
  const opened = task.kind === "failure" ? openFailure(task.error, "question") : null;

  return (
    <section className={styles.root} aria-label="Question" data-testid="task-detail">
      {task.kind === "loading" || task.kind === "idle" ? (
        <div className={styles.fixed} data-testid="task-loading" aria-busy="true" aria-label="Loading the question">
          <SkeletonItem size={28} />
        </div>
      ) : null}
      {task.kind === "failure" ? (
        <MessageBar intent="error" role="alert" className={styles.fixed} data-testid="task-error">
          <MessageBarBody>
            <MessageBarTitle>{opened?.title}</MessageBarTitle>
            {opened?.message}
            <TechnicalLine text={opened?.technical ?? null} />
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void actions.openTask(taskSeq)}>
              Try again
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
