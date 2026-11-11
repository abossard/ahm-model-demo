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
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { openFailure } from "../model/errors";
import { WORDS } from "../model/wording";
import { actions, useStore } from "../store/store";
import type { WorkspaceTab } from "../store/uiSlice";
import { LaunchNotice } from "./LaunchNotice";
import { TaskDetail } from "./TaskDetail";
import { TechnicalLine } from "./TechnicalLine";
import { TaskForm } from "./TaskForm";
import { TaskList } from "./TaskList";
import { WorkspaceHeader } from "./WorkspaceHeader";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, flex: 1, minHeight: 0 },
  fixed: { flexShrink: 0 },
  panel: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
});

export function SessionView(): JSX.Element {
  const styles = useStyles();
  const sessionId = useStore((state) => state.sessionId);
  const detail = useStore((state) => state.sessionDetail);
  const taskSeq = useStore((state) => state.taskSeq);
  const tab = useStore((state) => state.workspaceTab);
  // While the Task of a Session with none is being started, an empty list and a form would only be in the way.
  const starting = useStore((state) => state.launch.kind === "starting");
  const shownFailure = detail.kind === "failure" ? openFailure(detail.error, "topic") : null;

  return (
    <div className={styles.root} data-testid="session-view">
      <WorkspaceHeader
        title={detail.kind === "success" ? detail.value.session.title : "Topic"}
        titleTestId="session-title-heading"
        back={
          taskSeq !== null
            ? { label: "Questions", testId: "task-back", onClick: () => void actions.openTask(null) }
            : { label: "History", testId: "session-back", onClick: () => void actions.openSession(null) }
        }
      />

      <LaunchNotice />

      {detail.kind === "loading" || detail.kind === "idle" ? (
        <div className={styles.fixed} aria-busy="true" aria-label="Loading the topic" data-testid="session-loading">
          <SkeletonItem size={40} />
        </div>
      ) : null}
      {detail.kind === "failure" ? (
        <MessageBar intent="error" role="alert" className={styles.fixed} data-testid="session-error">
          <MessageBarBody>
            <MessageBarTitle>{shownFailure?.title}</MessageBarTitle>
            {shownFailure?.message}
            <TechnicalLine text={shownFailure?.technical ?? null} />
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void actions.openSession(sessionId)} data-testid="session-retry">
              Try again
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      {detail.kind === "success" && taskSeq !== null ? <TaskDetail /> : null}
      {detail.kind === "success" && taskSeq === null && !starting ? (
        <>
          <TabList
            className={styles.fixed}
            selectedValue={tab}
            onTabSelect={(_, data) => actions.setWorkspaceTab(data.value as WorkspaceTab)}
            aria-label="Topic"
          >
            <Tab value="tasks" data-testid="session-tab-tasks">
              {WORDS.questions} ({detail.value.tasks.length})
            </Tab>
            <Tab value="new" data-testid="session-tab-new">
              Ask something new
            </Tab>
          </TabList>
          <div className={styles.panel} role="tabpanel" aria-label={tab === "tasks" ? WORDS.questions : "Ask something new"}>
            {tab === "tasks" ? <TaskList tasks={detail.value.tasks} /> : <TaskForm />}
          </div>
        </>
      ) : null}
    </div>
  );
}
