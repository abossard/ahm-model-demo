import type { JSX } from "react";
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  SkeletonItem,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { actions, useStore } from "../store/store";
import type { WorkspaceTab } from "../store/uiSlice";
import { TaskDetail } from "./TaskDetail";
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

  return (
    <div className={styles.root} data-testid="session-view">
      <WorkspaceHeader
        title={detail.kind === "success" ? detail.value.session.title : "Session"}
        titleTestId="session-title-heading"
        back={
          taskSeq !== null
            ? { label: "Tasks", testId: "task-back", onClick: () => void actions.openTask(null) }
            : { label: "Sessions", testId: "session-back", onClick: () => void actions.openSession(null) }
        }
      />

      {detail.kind === "loading" || detail.kind === "idle" ? (
        <div className={styles.fixed} aria-busy="true" aria-label="Loading the Session" data-testid="session-loading">
          <SkeletonItem size={40} />
        </div>
      ) : null}
      {detail.kind === "failure" ? (
        <MessageBar intent="error" role="alert" className={styles.fixed} data-testid="session-error">
          <MessageBarBody>{detail.error.message}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void actions.openSession(sessionId)} data-testid="session-retry">
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      {detail.kind === "success" && taskSeq !== null ? <TaskDetail /> : null}
      {detail.kind === "success" && taskSeq === null ? (
        <>
          <TabList
            className={styles.fixed}
            selectedValue={tab}
            onTabSelect={(_, data) => actions.setWorkspaceTab(data.value as WorkspaceTab)}
            aria-label="Session"
          >
            <Tab value="tasks" data-testid="session-tab-tasks">
              Tasks ({detail.value.tasks.length})
            </Tab>
            <Tab value="new" data-testid="session-tab-new">
              New task
            </Tab>
          </TabList>
          <div className={styles.panel} role="tabpanel" aria-label={tab === "tasks" ? "Tasks" : "New task"}>
            {tab === "tasks" ? <TaskList tasks={detail.value.tasks} /> : <TaskForm />}
          </div>
        </>
      ) : null}
    </div>
  );
}
