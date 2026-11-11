import type { JSX } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { actions } from "../store/store";
import { LaunchNotice } from "./LaunchNotice";
import { TaskForm } from "./TaskForm";
import { WorkspaceHeader } from "./WorkspaceHeader";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, flex: 1, minHeight: 0 },
});

/** The form of a Task started before any Session exists: the Session is made when the form is sent, never before. */
export function NewTaskView(): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.root} data-testid="new-task-view">
      <WorkspaceHeader
        title="Ask the assistant"
        titleTestId="new-task-heading"
        back={{ label: "History", testId: "session-back", onClick: () => actions.setWorkspaceTab("tasks") }}
      />
      <LaunchNotice />
      <TaskForm />
    </div>
  );
}
